"""Small private inference API using the CAD-Coder authors' LLaVA loader."""

import base64
import io
import os
from threading import Lock

import torch
from fastapi import FastAPI, HTTPException
from huggingface_hub import snapshot_download
from PIL import Image
from pydantic import BaseModel, Field

from llava.constants import DEFAULT_IMAGE_TOKEN, IMAGE_TOKEN_INDEX
from llava.conversation import conv_templates
from llava.mm_utils import process_images, tokenizer_image_token
from llava.model.builder import load_pretrained_model
from llava.utils import disable_torch_init


MODEL_ID = "CADCODER/CAD-Coder"
DEFAULT_PROMPT = "Generate the CadQuery code needed to create the CAD for the provided image. Just the code, no other words."

app = FastAPI(title="CADAM CAD-Coder")
generation_lock = Lock()
state = {"ready": False, "error": None}


class GenerateRequest(BaseModel):
    image_base64: str = Field(min_length=16, max_length=20_000_000)
    prompt: str = Field(default=DEFAULT_PROMPT, min_length=1, max_length=1000)
    max_new_tokens: int = Field(default=2048, ge=64, le=3450)


@app.on_event("startup")
def load_model() -> None:
    try:
        disable_torch_init()
        path = snapshot_download(repo_id=MODEL_ID)
        tokenizer, model, processor, _ = load_pretrained_model(
            path, None, "CAD-Coder", device_map="auto"
        )
        model.eval()
        state.update(tokenizer=tokenizer, model=model, processor=processor, ready=True)
    except Exception as exc:
        state["error"] = str(exc)
        raise


@app.get("/health")
def health():
    if not state["ready"]:
        raise HTTPException(status_code=503, detail=state["error"] or "loading")
    return {"status": "ready", "model": MODEL_ID, "format": "cadquery"}


@app.post("/generate")
def generate(request: GenerateRequest):
    if not state["ready"]:
        raise HTTPException(status_code=503, detail="model loading")
    try:
        raw = base64.b64decode(request.image_base64, validate=True)
        image = Image.open(io.BytesIO(raw)).convert("RGB")
    except Exception as exc:
        raise HTTPException(status_code=400, detail="invalid image") from exc

    tokenizer = state["tokenizer"]
    model = state["model"]
    processor = state["processor"]
    question = DEFAULT_IMAGE_TOKEN + "\n" + request.prompt
    conv = conv_templates["llava_v1"].copy()
    conv.append_message(conv.roles[0], question)
    conv.append_message(conv.roles[1], None)
    input_ids = tokenizer_image_token(
        conv.get_prompt(), tokenizer, IMAGE_TOKEN_INDEX, return_tensors="pt"
    ).unsqueeze(0).cuda()
    image_tensor = process_images([image], processor, model.config)[0]
    with generation_lock, torch.inference_mode():
        output_ids = model.generate(
            input_ids,
            images=image_tensor.unsqueeze(0).half().cuda(),
            image_sizes=[image.size],
            do_sample=False,
            max_new_tokens=request.max_new_tokens,
            use_cache=True,
        )
    code = tokenizer.batch_decode(output_ids, skip_special_tokens=True)[0].strip()
    return {"model": MODEL_ID, "sourceFormat": "cadquery", "code": code}
