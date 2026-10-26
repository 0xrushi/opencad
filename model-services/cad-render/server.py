"""Bounded CAD sequence/CadQuery renderer for CADAM's private model host."""

import json
import subprocess
import sys
from typing import Literal

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

app = FastAPI(title="CADAM geometry renderer")


class Op(BaseModel):
    type: Literal[
        "cut", "hole", "fillet", "chamfer", "scale", "translate", "mirror", "stretch", "fill",
        "remove", "delete", "pocket", "boss", "text", "shell", "offset_face", "rib", "draft", "pattern", "combine",
    ]
    origin: list[float] | None = Field(default=None, min_length=3, max_length=3)
    normal: list[float] | None = Field(default=None, min_length=3, max_length=3)
    keep: Literal["positive", "negative", "split"] | None = None
    diameter: float | None = Field(default=None, gt=0)
    depth: float | None = Field(default=None, gt=0)
    radius: float | None = Field(default=None, gt=0)
    distance: float | None = None  # signed for stretch; other ops check it themselves
    factor: float | None = Field(default=None, gt=0)
    vector: list[float] | None = Field(default=None, min_length=3, max_length=3)
    points: list[list[float]] | None = Field(default=None, max_length=24)
    # Features: pocket/boss/text/rib/draft/pattern/shell and hole variants.
    normal2: list[float] | None = Field(default=None, min_length=3, max_length=3)
    profile: Literal["circle", "rect", "slot"] | None = None
    width: float | None = Field(default=None, gt=0)
    height: float | None = Field(default=None, gt=0)
    rotation: float | None = None
    text: str | None = Field(default=None, max_length=80)
    size: float | None = Field(default=None, gt=0)
    thickness: float | None = Field(default=None, gt=0)
    count: int | None = Field(default=None, ge=2, le=64)
    angle: float | None = Field(default=None, gt=-360, lt=720)
    kind: Literal["linear", "circular"] | None = None
    style: Literal["simple", "counterbore", "countersink"] | None = None
    head_diameter: float | None = Field(default=None, gt=0)
    head_depth: float | None = Field(default=None, gt=0)
    of: "Op | None" = None
    mode: Literal["union", "subtract", "intersect"] | None = None
    other_step: str | None = Field(default=None, max_length=30_000_000)  # base64 STEP of the other version


Op.model_rebuild()


class RenderRequest(BaseModel):
    sourceFormat: Literal["cad-sequence", "cadquery", "step", "stl"]
    source: str = Field(default="", max_length=200_000)
    # Uploaded STEP/STL bytes, base64 (about 25 MB of file).
    sourceBase64: str | None = Field(default=None, max_length=36_000_000)
    ops: list[Op] = Field(default_factory=list, max_length=24)
    preview: bool = False  # return only the faces the last fill would remove


@app.get("/health")
def health():
    return {"status": "ready", "formats": ["cad-sequence", "cadquery", "step", "stl"]}


@app.post("/render")
def render(request: RenderRequest):
    if request.sourceFormat in ("step", "stl"):
        if not request.sourceBase64:
            raise HTTPException(status_code=400, detail="the uploaded file is missing")
    elif not request.source:
        raise HTTPException(status_code=400, detail="the model source is missing")
    try:
        process = subprocess.run(
            [sys.executable, "-I", "/opt/cadam/worker.py"],
            input=request.model_dump_json(),
            text=True,
            capture_output=True,
            timeout=60,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise HTTPException(status_code=422, detail="CAD render timed out") from exc
    if process.returncode != 0:
        raise HTTPException(
            status_code=422,
            detail=(process.stderr or process.stdout)[-500:] or "CAD render failed",
        )
    try:
        return json.loads(process.stdout)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=500, detail="CAD render returned invalid data") from exc
