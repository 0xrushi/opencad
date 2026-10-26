FROM python:3.12-slim-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends libgl1 libxrender1 libxext6 fonts-dejavu-core && rm -rf /var/lib/apt/lists/*
RUN python3 -m pip install --no-cache-dir 'cadquery==2.8.0' 'fastapi>=0.115,<1' 'uvicorn>=0.34,<1'

COPY server.py worker.py features.py /opt/cadam/
WORKDIR /opt/cadam
ENV PYTHONPATH=/opt/cad-editor/utils PYTHONUNBUFFERED=1
USER 65532:65532
ENTRYPOINT ["python3", "-m", "uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8000"]
