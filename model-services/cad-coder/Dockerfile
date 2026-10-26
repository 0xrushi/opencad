# ARM64 CUDA 13 base already used on the GB10 host. Pin the image digest so
# rebuilds do not silently change the inference runtime.
FROM vllm/vllm-openai@sha256:3dbe092ec5b2cef63b6104d33fa75d6ce53a7870962529ada69f78bbbc38e776

ENV HF_HOME=/models/hf \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/opt/cad-coder

RUN python3 -m pip install --no-cache-dir \
        'transformers==4.37.2' \
        'accelerate==0.34.2' \
        'sentencepiece==0.2.0' \
        'shortuuid==1.0.13' \
        'einops-exts==0.0.4' \
        'timm==1.0.20' \
        'huggingface-hub>=0.30,<1' \
        'fastapi>=0.115,<1' \
        'uvicorn>=0.34,<1' \
        'pillow>=11,<12'

COPY server.py /opt/cadam/server.py
WORKDIR /opt/cadam
ENTRYPOINT ["python3", "-m", "uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8000"]

LABEL org.opencontainers.image.title="CADAM CAD-Coder inference" \
      org.opencontainers.image.source="https://github.com/anniedoris/CAD-Coder" \
      org.opencontainers.image.description="Image-to-CadQuery model service"
