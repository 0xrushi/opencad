# CADFusion: Text-to-CAD Generation Through Infusing Visual Feedback in Large Language Models

**Task:** Create a parametric CAD model from a natural-language description.  
**Input:** Text description.  
**Output:** A text-serialized parametric CAD construction sequence that can be rendered into a 3D object.  
**Paper:** [arXiv:2501.19054](https://arxiv.org/abs/2501.19054) (ICML 2025).  
**Code:** [microsoft/CADFusion](https://github.com/microsoft/CADFusion).

## Why it exists

Supervision on a single reference CAD sequence teaches a model to reproduce that sequence, but different construction sequences can render to similar objects. CADFusion therefore trains on both the **sequence** and feedback about the **rendered shape**. Its visual feedback happens during training; inference still takes text and emits a CAD sequence.

## How it works

1. **Build text–sequence pairs.** Starting from DeepCAD-derived parametric sequences, the authors render the models, use a vision-language model to draft captions, and refine descriptions with human annotation. CAD operations are serialized as text tokens for an LLM.
2. **Sequential learning (SL).** Fine-tune LLaMA-3-8B-Instruct to predict the ground-truth CAD sequence from its description with standard next-token cross-entropy. This teaches the operation vocabulary and sequence structure.
3. **Generate candidates and render them.** For a text prompt, sample several CAD sequences from the current model and render valid ones to images.
4. **Score visual outcomes.** A vision-language model grades each rendered image against the prompt for shape quality, component count, and component arrangement. Higher- and lower-scored candidates form preference pairs.
5. **Visual feedback (VF).** Direct Preference Optimization (DPO) increases the relative probability of the CAD sequence that rendered the preferred object and decreases that of the less preferred one. This uses visual judgments without differentiating through the CAD renderer.
6. **Alternate VF and SL.** After initial sequential learning, the authors repeatedly run a short visual-feedback phase followed by a short sequential-learning phase. The second phase helps retain well-formed CAD sequence generation while visual preferences improve the rendered result.

The reported training run starts with 40 SL epochs, then performs five VF/SL rounds. Each round uses about 1,500 preference pairs; the paper uses `llava-onevision-qwen2-7b` for preference scoring. The published repository also provides model checkpoints and scripts for training, generation, rendering, and evaluation.

## What the output means

The model predicts a **parametric operation history**, rather than a mesh or CadQuery source code. The repository's inference workflow can render generated sequences and export geometry such as STEP and STL. Those exports are downstream products of the predicted sequence.

## Practical interpretation and limits

The visual feedback improves the model's ability to choose sequences whose **renderings** fit the prompt. It does not amount to image-conditioned inference or a differentiable geometry engine. The paper reports that its visual judge uses a single rendered view because multi-image understanding was less reliable in its setup. The [official repository](https://github.com/microsoft/CADFusion) was archived on October 2, 2026 and is read-only.

## Sources

- [Paper, method and experiments](https://arxiv.org/html/2501.19054v3)
- [Official implementation and README](https://github.com/microsoft/CADFusion)
