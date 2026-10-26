# CADAM model services on alpha

Remote directory: `/home/alpha/Documents/CADAM-models`. Each upstream checkout lives in `upstream/`, is pinned to the commit in [`upstream.lock`](upstream.lock), and is mounted read-only into its container. Dockerfiles contain runtime dependencies and the CADAM API wrapper; they do not clone source. Model weights and the Hugging Face cache live in `base/` and `hf-cache/` outside Git.

## Services

| Service | Input | Output | Host port | Source mount |
| --- | --- | --- | --- | --- |
| CADFusion | `POST /generate` with `description` | CAD operation sequence | `127.0.0.1:18082` | `upstream/CADFusion` |
| CAD-Editor | `POST /edit` with `original_sequence` and `instruction` | Mask and edited CAD sequence | `127.0.0.1:18083` | `upstream/CAD-Editor` |
| CAD-Coder | `POST /generate` with `image_base64` | CadQuery Python | `127.0.0.1:18081` | `upstream/CAD-Coder` |
| cad-render | `POST /render` with `source`, `sourceFormat`, `ops` | STL and STEP | `127.0.0.1:18084` | none (CadQuery in the image) |
| cad-planner | `POST /plan` with `instruction`, `context` | Symbolic operations (`cut`, `hole`, `fillet`, `chamfer`, `scale`, `translate`, `mirror`), `model`, or `clarify` | `127.0.0.1:18085` | none (uses `base/Meta-Llama-3-8B-Instruct`) |

Each service exposes `GET /health`. Its endpoint is ready only after weights load. Ports bind to loopback on alpha; connect through SSH for local development. `CAD-Tokenizer` has no serving image because the [official repository](https://github.com/rwang37/CAD-Tokenizer) has not released code or weights.

## Operations

From `/home/alpha/Documents/CADAM-models`:

```sh
docker compose --profile gated -f compose.yml config --quiet
docker compose --profile gated -f compose.yml build cad-fusion cad-editor cad-coder
docker compose --profile gated -f compose.yml up -d cad-fusion cad-editor cad-coder
docker compose --profile gated -f compose.yml ps
docker compose --profile gated -f compose.yml logs --tail 100 cad-fusion cad-editor cad-coder
```

The sequence services require the official Meta Llama 3 8B base files at `base/Meta-Llama-3-8B` and `base/Meta-Llama-3-8B-Instruct`. They use the public CADFusion and CAD-Editor adapters in the mounted Hugging Face cache. The CAD-Coder service downloads its public checkpoint to that cache. Do not copy an HF access token into this directory or the images.

These are model services only. CADAM's application still needs the artifact-format and routing changes in [`../plan.md`](../plan.md) before it can call them.

## Verified status (2026-10-25)

CADFusion, CAD-Editor, and CAD-Coder were built and started on alpha. All three reported healthy through Docker Compose, and sample requests to `/generate`, `/edit`, and `/generate` respectively returned HTTP 200 with nonempty output. CAD-Coder's sample used `upstream/CAD-Coder/inference/test100_images/00211465_0.png`. These smoke checks establish model loading and API inference; they do not establish that generated geometry parses, executes, or exports. CADAM application routing is still pending.

## Planner and exact operations

`cad-planner` runs the already-present Meta-Llama-3-8B-Instruct to turn a request plus the selected geometry into symbolic operations. It never emits coordinates: it names faces and edges (`F3`, `E5`) and relations, CADAM resolves them to numbers, and `cad-render` executes them in CadQuery. Output is schema-validated; every face/edge id must exist in the request context, and every numeric parameter must be a number written in the request (or a percentage or "half/twice" of one). Requests it cannot express as operations return `intent: "model"` and go to CADFusion/CAD-Editor as before. Note this is a fifth self-hosted open model beyond the four in `plan.md`; no proprietary API is involved.

## Renderer tests

`cad-render/tests/` holds the fill-cavity regression tests (synthetic pocket and
blind hole, the capping fallback with defeaturing forced off, fill preview, and
optional real-part checks). Run them against a running renderer container:

```sh
sh model-services/cad-render/tests/run.sh cadam-models-cad-render-1 /path/to/wall-mount.stp
```

The STEP argument is optional; without it only the synthetic cases run.
`fill` also supports a preview (`preview: true` on `/render`) that returns just
the faces it would remove, which the app draws in red before the user confirms.
