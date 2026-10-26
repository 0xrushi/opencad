"""Private CAD-Editor locate-then-infill inference service."""

from threading import Lock

import torch
from fastapi import FastAPI, HTTPException
from huggingface_hub import snapshot_download
from peft import PeftModel
from pydantic import BaseModel, Field
from transformers import AutoModelForCausalLM, AutoTokenizer

from finetune.llama_sample import get_prompt_template


BASE = "/models/base/Meta-Llama-3-8B-Instruct"
ADAPTER = "microsoft/CAD-Editor"
app = FastAPI(title="CADAM CAD-Editor")
lock = Lock()
state = {"ready": False}


class EditRequest(BaseModel):
    original_sequence: str = Field(min_length=1, max_length=12000)
    instruction: str = Field(min_length=1, max_length=2000)
    max_new_tokens: int = Field(default=512, ge=64, le=768)


@app.on_event("startup")
def load_model() -> None:
    adapter_repo = snapshot_download(repo_id=ADAPTER)
    tokenizer = AutoTokenizer.from_pretrained(BASE, use_fast=False)
    model = AutoModelForCausalLM.from_pretrained(
        BASE, torch_dtype=torch.bfloat16, device_map="auto"
    )
    special_tokens = {}
    if tokenizer.pad_token is None:
        special_tokens["pad_token"] = "[PAD]"
    if tokenizer.unk_token is None:
        special_tokens["unk_token"] = "<unk>"
    if special_tokens:
        tokenizer.add_special_tokens(special_tokens)
        model.resize_token_embeddings(len(tokenizer))
    model = PeftModel.from_pretrained(
        model, f"{adapter_repo}/locate_stage", adapter_name="locate"
    )
    model.load_adapter(f"{adapter_repo}/infill_stage", adapter_name="infill")
    model.eval()
    state.update(tokenizer=tokenizer, model=model, ready=True)


def infer(prompt: str, adapter: str, max_new_tokens: int) -> str:
    tokenizer = state["tokenizer"]
    model = state["model"]
    model.set_adapter(adapter)
    encoded = tokenizer(prompt, return_tensors="pt").to(model.device)
    with torch.inference_mode():
        generated = model.generate(
            **encoded,
            do_sample=True,
            temperature=0.3,
            top_p=0.9,
            repetition_penalty=1.3,
            max_new_tokens=max_new_tokens,
        )
    return tokenizer.decode(
        generated[0][encoded["input_ids"].shape[1] :], skip_special_tokens=True
    ).strip()


@app.get("/health")
def health():
    if not state["ready"]:
        raise HTTPException(status_code=503, detail="loading")
    return {"status": "ready", "model": ADAPTER, "format": "cad-sequence"}


@app.post("/edit")
def edit(request: EditRequest):
    if not state["ready"]:
        raise HTTPException(status_code=503, detail="loading")
    item = {"original_sequence": request.original_sequence}
    with lock:
        mask_prompt = get_prompt_template("mask", item, request.instruction)
        mask = infer(mask_prompt, "locate", request.max_new_tokens)
        item["output_mask"] = mask
        infill_prompt = get_prompt_template("infill", item, request.instruction)
        sequence = infer(infill_prompt, "infill", request.max_new_tokens)
    return {
        "model": ADAPTER,
        "sourceFormat": "cad-sequence",
        "masked_sequence": mask,
        "sequence": sequence,
    }
