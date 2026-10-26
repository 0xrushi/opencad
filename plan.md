# CADAM open-model migration plan

## Goal

Use only the four CAD research model families documented in `research/` for new AI CAD generation and editing. Run model inference on `alpha@192.168.1.174` under `~/Documents`, with a checked-in Dockerfile for every model-serving environment. Keep model weights outside Git.

## Current state and design constraints

- CADAM's parametric chat currently asks hosted general models to call `build_parametric_model` with **OpenSCAD** source. The browser compiles and previews that source. CADFusion, CAD-Editor, and CAD-Tokenizer produce sketch-and-extrusion sequences; CAD-Coder produces **CadQuery Python**. The app needs a new artifact contract and rendering path rather than a provider-ID swap.
- The model picker contains hosted models; creative mesh and image flows use hosted services in `src/server/mesh.ts` and `src/server/imageGen.ts`. Title, suggestion, and prompt helpers also call hosted models. A strict “these open models only” cutover must remove or disable these paths for new requests, while keeping saved content readable.
- The remote machine is reachable by SSH and has Docker, NVIDIA GB10, and roughly 1.3 TB free in `~/Documents` as inspected on 2026-10-25. There are other Docker projects there; CADAM should use its own directory, Compose project name, ports, and volumes.
- [CADFusion](https://huggingface.co/microsoft/CADFusion), [CAD-Editor](https://huggingface.co/microsoft/CAD-Editor), and [CAD-Coder](https://huggingface.co/CADCODER/CAD-Coder) publish checkpoints. CADFusion and CAD-Editor use LLaMA-3 8B adapters/base weights. The [CAD-Tokenizer repository](https://github.com/rwang37/CAD-Tokenizer) currently says code is still being prepared; its [paper page](https://huggingface.co/papers/2509.21150) links no model checkpoint. Its integration needs a release or a separately validated reproduction.

## To do

### 1. Freeze the model and artifact contracts

- [x] Document the four research approaches in `research/`.
- [x] Create the project-local SSH/Docker skill at `.agents/skills/cadam-remote/` and verify SSH access.
- [ ] Define app operations: text-to-CAD via CADFusion; edit an existing sequence via CAD-Editor; image-to-CadQuery via CAD-Coder; unified generate/edit via CAD-Tokenizer when deployable.
- [ ] Define typed request/response schemas with `sourceFormat` (`cad-sequence`, `cadquery`, or legacy `openscad`), model ID, units, original artifact reference, error status, and preview/export references.
- [ ] Decide how old OpenSCAD projects remain viewable and how an edit request against one is handled. Do not feed OpenSCAD directly to CAD-Editor as if it were its training format.

### 2. Build and validate remote services

- [x] Create a CADAM-owned directory under `~/Documents` and a dedicated Compose project. Review existing Docker examples for GB10 settings, then add checked-in Dockerfiles and Compose configuration in this repository.
- [x] Clone upstream repositories under the remote CADAM directory at pinned commits and bind mount them read-only into their model containers; Dockerfiles install runtime dependencies only.
- [ ] Pin upstream commits, Python/CUDA dependencies, checkpoint revisions, and base-model versions. Verify licenses and access to any gated LLaMA weights.
- [ ] Build a CADFusion text-to-sequence service; generate, parse, render, and export a representative part.
- [ ] Build a CAD-Editor locate/infill service; edit a generated sequence and verify the requested change plus preservation of unaffected features.
- [ ] Build a CAD-Coder image-to-CadQuery service; execute a representative generated script in an isolated container and verify a solid/export.
- [ ] Track CAD-Tokenizer code and weights. Add its Dockerfile and service only when the official artifact or a tested reproduction is usable; never substitute a different model under its name.
- [ ] Add `/health` and model metadata endpoints, bounded input sizes, timeouts, logs, and a private connection from CADAM to the host. Run one model at a time if GB10 memory demands it.

Deployment check on 2026-10-25: CADFusion, CAD-Editor, and CAD-Coder are running in Docker on alpha and report healthy. Sample text generation, sequence editing, and image-to-CadQuery requests returned HTTP 200 with nonempty outputs. 

### 3. Change CADAM

- [x] Replace the hosted-model picker and server routing with only deployable models from this plan; reject retired IDs for new AI requests without falling back to proprietary APIs. (`/api/local-cad` routes to the three services; `/api/parametric-chat` returns 410.)
- [ ] Replace the OpenSCAD-only tool and persistence schema with format-aware CAD artifacts. Keep historical OpenSCAD rendering and downloads intact.
- [ ] Add rendering/export support for sketch-and-extrusion sequences and CadQuery outputs. Show which format a result uses and preserve editable source/history.
- [x] Route new text generation to CADFusion, existing-sequence edits to CAD-Editor, and image reconstruction to CAD-Coder. Expose CAD-Tokenizer only after its service passes validation.
- [x] Replace or retire creative mesh, image generation/editing, prompt generation, titles, and suggestions that call Anthropic, Google, OpenAI, OpenRouter, or Fal. Routes return 410 and the `aiChat`, `anthropic`, `mesh`, `imageGen`, `falWebhook`, and `modelCapabilities` server modules are deleted.
- [x] Review billing and token accounting, since the current price table assumes hosted providers. Update user-facing labels and limits for self-hosted inference.

### 4. Verify cutover

- [ ] Test text-to-CAD, follow-up edit, and image-to-CadQuery through the app, including preview, download, saved conversation reload, and failure handling.
- [ ] Test an old OpenSCAD conversation for read compatibility.
- [ ] Run typecheck, build, and relevant integration tests; validate remote Docker build, health, inference, and CAD execution.
- [x] Audit new-request code paths for remaining proprietary model calls and remove their environment variables from deployment configuration once unused.

## Acceptance criteria

New CAD requests use only the named available open models on the remote host; no new-request path calls a hosted proprietary model. Generated artifacts compile or execute into valid 3D output and remain editable in their native format. Existing projects still open. Every model service is reproducible from a Dockerfile and can be started independently without affecting other remote containers.

## Verification on alpha, 2026-10-25

- `cad-render` fixed (AST allowlist lacked `ast.alias`, so every CadQuery import failed; `-I` dropped `PYTHONPATH`, so the sequence parser was not found) and redeployed.
- CADFusion sequence -> STL/STEP: works. CAD-Coder CadQuery -> STL/STEP: works. `import os` is rejected by the sandbox.
- CAD-Editor returns a valid appended sequence that parses and renders, but for "add a slot" the cut landed outside the plate, so geometry was unchanged. Treat edit quality (and cut-plane handling in `worker.py`) as an open item.
- Not yet exercised through the browser UI.

## Previously (was blocked: alpha unreachable at 192.168.1.174 on 2026-10-25, 'No route to host')

- Run end-to-end checks through the app once the host is back: text-to-CAD, follow-up edit, image-to-CadQuery, reload, download.
- Verify cad-render health and that generated sequences/CadQuery actually produce STL/STEP.
- Review billing/token accounting (hosted-provider env vars already removed from `.env.local.template`; check deploy config separately).

## Exact operations and planner (2026-10-25)

- Added `cad-planner` (Llama-3-8B-Instruct, self-hosted) and ordered kernel operations (`cut`, `hole`, `fillet`, `chamfer`, `scale`, `translate`, `mirror`) executed by `cad-render`; saved on the artifact as `ops` and re-applied after model edits.
- Free-form requests with a face/edge selection go planner-first; generative requests still use CADFusion/CAD-Editor. Keyword routing remains only as a fallback when the planner is unavailable.
- Deviation to confirm: the planner is a fifth open model beyond the four research models listed above.
- Since added: `stretch`, `fill` (round holes, then any cavity via concave/tangent region + defeaturing, with a capping fallback and a leftover-void check), a red fill preview with confirm, the `across_edge` plane, edits branching from the version on screen, and renderer regression tests (`model-services/cad-render/tests/`).

## Next: more planes, references, operations and measurements

Every item below needs the same four pieces, and is not done until all four exist:

1. **Renderer** (`cad-render/worker.py`, `server.py` `Op` model): the kernel operation, refusing with a readable reason and never returning an unchanged part.
2. **Planner** (`cad-planner/server.py`): the op/plane/point in the prompt, a validator (refs exist and have the right kind, numbers come from the request), and at least one example.
3. **App** (`src/lib/cadPlan.ts`, `cadTopology.ts`, `shared/chatAi.ts`, editor UI): the plan type, the resolver to numeric ops, `describePlan`, and unit tests.
4. **Verification**: a renderer test in `cad-render/tests/` and one run in the browser on the wall-mount STEP.

Destructive or hard-to-picture operations (pocket, boss, shell, pattern, remove feature) get a preview and a confirm step, like fill.

### Phase 1: references (unblocks most of the rest)

- [x] **Vertex picking**: corners become selectable `V<n>` items (viewer snapping, chips, `buildPlanContext`, planner `REF`).
- [x] **Point along an edge**: `{"along": REF, "fraction": 0.3}` and `{"along": REF, "distance": d, "from": "start"|"end"|V}`.
- [x] **Hole and arc centres as targets**: `{"center_of": REF}` for circle/arc edges and cylindrical faces.
- [x] **"Same as" values**: take a diameter, radius or distance from an existing feature (`{"same_as": REF, "what": "diameter"}`) instead of requiring the number in the text.

### Phase 2: plane types

- [x] Through 3 points (vertices or any POINT).
- [x] Through an edge and a point.
- [x] Through an edge at an angle to a face (`angle` in degrees, from the request).
- [x] Tangent to a curved face (cylinder/cone: along the axis, at the side named or nearest the selection).
- [x] Through a hole's axis (contains the axis; orientation from a second ref or the nearest principal direction).
- [x] Mid-plane of the part or a feature along an axis (bounding-box based, generalising `axis`).
- [x] Rotated plane (a base plane rotated by an angle about an axis or an edge).

### Phase 3: operations

- [x] **Pocket / cut-extrude**: rectangle, circle or slot on a planar face at a POINT, with size, depth (or through) and rotation.
- [x] **Boss / extrude**: the same profiles added outward; also "pull this face out d" for a whole planar face.
- [x] **Hole variants**: counterbore, countersink, and metric sizes (M2–M12 clearance and tap-drill tables).
- [x] **Patterns**: linear (count, spacing, direction) and circular (count, axis, angle) of a hole, pocket or boss.
- [x] **Shell / hollow**: wall thickness, optional open faces.
- [x] **Offset face**: move a planar face in or out (builds on `stretch`).
- [x] **Remove feature**: generalise fill's defeaturing to fillets, chamfers and bosses.
- [x] **Text emboss/engrave** on a planar face (font size, depth, position).
- [x] **Rib / gusset** between two faces (thickness, from the request).
- [x] **Draft** on selected faces (angle, pull direction). Kernel support is fragile, so this comes last.
- [x] **Combine with another version** (union, subtract or intersect a saved version of the same conversation).

### Phase 4: measurements and checks (answers only, no geometry change)

- [x] Angle between two faces or edges.
- [x] Wall thickness at a point or face.
- [x] Volume, surface area, bounding box, and mass from a chosen material density.
- [x] Hole list: diameter, depth and position of every round hole.
- [x] Printability: thin walls below a threshold, and overhangs beyond an angle.

### Status (2026-10-26)

Phases 1 to 4 are implemented: renderer operations (`cad-render/features.py`, `worker.py`) with tests in `cad-render/tests/` (39 passing on alpha), planner grammar, validators and examples (`cad-planner/server.py`, which now picks the most relevant examples per request so the prompt fits the 8k context), the app resolvers in `src/lib/cadPlan.ts` and `cadMeasure.ts`, and unit tests (67 passing). Notes and limits:

- Pocket, boss, hole variants, pattern, shell, offset face, text, rib, draft and combine run in the CAD kernel on STEP/CadQuery parts; STL imports stay view-only.
- Fill and remove show a red preview and ask to confirm; other operations apply immediately and can be undone.
- Metric hole sizes use standard tables (clearance, tap drill, socket head, flat head) and need the real size set above the preview.
- Combine names saved versions by number; it uses the part's own coordinates, so it suits versions of the same part.
- Measurements (angle, thickness, volume, mass, bounding box, holes, printability) are computed from the recovered mesh in the browser. Printability assumes +Z up and a 0.8 mm minimum wall unless the request gives one.
- Draft and shell depend on the kernel and can be refused on some shapes with a readable reason.
- Not yet exercised in the browser: each new operation was checked in the renderer and with unit tests, and a sample of phrasings was run through the planner.

### Order and acceptance

Phase 1 → Phase 2 → Phase 3 in the listed order (pocket, boss and hole variants first) → Phase 4, which can run alongside since it is independent. Each phase is accepted when its items pass the renderer tests and the app unit tests and plan correctly from at least two phrasings. Requests the planner still cannot express must end in `clarify` with a specific reason, never a forced nearest operation.
