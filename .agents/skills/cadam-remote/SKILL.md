---
name: cadam-remote
description: Work on CADAM's self-hosted CAD model services on alpha@192.168.1.174 under ~/Documents over SSH. Use for remote inspection, Docker builds, model downloads, service checks, and deployment of CADFusion, CAD-Editor, CAD-Coder, or CAD-Tokenizer.
---

# CADAM remote model host

The CADAM source checkout is local. Run model inference and model-specific dependencies on `alpha@192.168.1.174` under `~/Documents`. Use this skill when the task involves that host; it does not authorize changes to unrelated remote projects.

## Connect and inspect

- Use `scripts/remote.sh '<remote shell command>'` from this skill directory, or equivalent `ssh -o BatchMode=yes -o ConnectTimeout=5 alpha@192.168.1.174 '<command>'`.
- For a connectivity check, use `scripts/remote.sh --check`. If SSH is denied by the local sandbox, request tool escalation for that exact command. Never copy private keys into the repository.
- The remote home is `/home/alpha`. `~/Documents` is `/home/alpha/Documents` on that host. Check the target directory with `pwd` before writing; do not assume a CADAM deployment directory already exists.
- Before choosing a container base or GPU settings, inspect relevant examples in `~/Documents/DeepSeek-v4-Flash-DSpark-2x-DGX-Spark/` and `~/Documents/lensos/`. The host has an NVIDIA GB10 and Docker with GPU support; use current host state as the source of truth.

## Model workflow

- Use only the CAD model families described in the local `research/` notes: CADFusion, CAD-Editor, CAD-Coder (the image-to-CadQuery model at `CADCODER/CAD-Coder`), and CAD-Tokenizer when its implementation and weights are actually available. A similarly named text-to-CAD CAD-Coder is a different project.
- Put each model service's reproducible environment in a checked-in `Dockerfile`; use Docker or Docker Compose for installs, downloads, inference, and verification. Do not install model dependencies directly on the remote host. Keep large weights in a remote cache or mounted volume under `~/Documents`, outside Git.
- Clone each upstream model repository into a CADAM-owned directory under remote `~/Documents`, pin its commit, and bind mount that checkout into its container. Do not clone upstream source in a Dockerfile.
- Check the upstream repository, checkpoint format, base-model requirements, license, and available disk/GPU memory before downloading or building. CADFusion and CAD-Editor publish adapter checkpoints; verify their base weights and loading recipes. Do not present CAD-Tokenizer as deployable until its code and weights are released or a reproduction is implemented and validated.
- Stage CADAM-owned source under a dedicated `~/Documents` path. Review a transfer command and its target before using `rsync` or `scp`. Do not overwrite or stop other projects' containers.
- Bind the inference API to a private interface or loopback plus SSH tunnel. Record the health endpoint, model ID, image digest, and API contract in CADAM deployment notes. Avoid putting authentication tokens in shell arguments, logs, images, or committed files.
- After a change, verify `docker compose config`, image build, container health, one representative inference, and CAD parse/render or CadQuery execution as appropriate. Shut down only containers created for CADAM when needed.

## App integration

CADAM currently expects OpenSCAD in `build_parametric_model`. These research models output sketch-and-extrusion sequences or CadQuery code. Update the application artifact contract and renderer deliberately; do not label either format as OpenSCAD or silently convert a mesh back into an editable construction history. Keep historical OpenSCAD artifacts readable while removing proprietary model inference from new requests.
