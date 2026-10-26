"""Private CADFusion text-to-CAD service using its released v1.1 adapter."""

from threading import Lock

import torch
from fastapi import FastAPI, HTTPException
from huggingface_hub import snapshot_download
from peft import PeftModel
from pydantic import BaseModel, Field
from transformers import AutoModelForCausalLM, AutoTokenizer


BASE = "/models/base/Meta-Llama-3-8B"
ADAPTER = "microsoft/CADFusion"
app = FastAPI(title="CADAM CADFusion")
lock = Lock()
state = {"ready": False}


class GenerateRequest(BaseModel):
    description: str = Field(min_length=1, max_length=3000)
    max_new_tokens: int = Field(default=512, ge=64, le=768)


@app.on_event("startup")
def load_model() -> None:
    adapter_repo = snapshot_download(repo_id=ADAPTER, allow_patterns=["v1_1/*"])
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
    model = PeftModel.from_pretrained(model, f"{adapter_repo}/v1_1")
    model.eval()
    state.update(tokenizer=tokenizer, model=model, ready=True)


@app.get("/health")
def health():
    if not state["ready"]:
        raise HTTPException(status_code=503, detail="loading")
    return {"status": "ready", "model": ADAPTER, "format": "cad-sequence"}


@app.post("/generate")
def generate(request: GenerateRequest):
    if not state["ready"]:
        raise HTTPException(status_code=503, detail="loading")
    prompt = (
        "Below is a description of a 3D shape:\n"
        + request.description
        + "\nGenerate a Computer-Aided Design(CAD) command sequence of the 3D shape:\n"
    )
    tokenizer = state["tokenizer"]
    model = state["model"]
    encoded = tokenizer(prompt, return_tensors="pt").to(model.device)
    with lock, torch.inference_mode():
        generated = model.generate(
            **encoded,
            do_sample=True,
            temperature=0.3,
            top_p=0.9,
            repetition_penalty=1.3,
            max_new_tokens=request.max_new_tokens,
        )
    sequence = tokenizer.decode(
        generated[0][encoded["input_ids"].shape[1] :], skip_special_tokens=True
    ).strip()
    return {"model": ADAPTER, "sourceFormat": "cad-sequence", "sequence": sequence}
