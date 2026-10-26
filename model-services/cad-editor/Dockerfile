FROM vllm/vllm-openai@sha256:3dbe092ec5b2cef63b6104d33fa75d6ce53a7870962529ada69f78bbbc38e776

ENV HF_HOME=/models/hf PYTHONUNBUFFERED=1 PYTHONPATH=/opt/cad-editor

RUN python3 -m pip install --no-cache-dir \
    'transformers==4.44.2' 'peft==0.13.2' 'accelerate==0.34.2' \
    'huggingface-hub>=0.30,<1' 'fastapi>=0.115,<1' 'uvicorn>=0.34,<1'

COPY server.py /opt/cadam/server.py
WORKDIR /opt/cadam
ENTRYPOINT ["python3", "-m", "uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8000"]
