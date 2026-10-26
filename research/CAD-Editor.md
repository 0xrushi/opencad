# CAD-Editor: A Locate-then-Infill Framework with Automated Training Data Synthesis for Text-Based CAD Editing

**Task:** Modify an existing parametric CAD model from a natural-language instruction.  
**Input:** Original sketch-and-extrusion CAD sequence and edit instruction.  
**Output:** Edited sketch-and-extrusion CAD sequence.  
**Paper:** [arXiv:2502.03997](https://arxiv.org/abs/2502.03997).  
**Code:** [microsoft/CAD-Editor](https://github.com/microsoft/CAD-Editor).

## Why it exists

Text-to-CAD generation starts from an empty model, while editing must interpret an instruction **and preserve unaffected parts** of an existing construction history. Training also needs triples of original model, instruction, and desired edited model. Such triples are scarce, so CAD-Editor combines synthetic data creation with a two-stage editing model.

## How the training data is made

1. Start with an existing model from DeepCAD and use the Hnc-CAD design-variation model to create related CAD models.
2. Form original/edited pairs from an original and a variant, reverse those roles, or pair two different variants. This supplies additions, deletions, and replacements.
3. Render the paired models and inspect their operation sequences. Vision-language and language models describe each model, identify their differences, and compress those differences into a text edit instruction. The visual view helps with shape-level changes; the sequence exposes exact parametric changes.
4. Assemble `(instruction, original sequence, edited sequence)` triples. The paper reports 120,000 synthetic training examples and a manually checked test set of 2,000 examples.

Images are used to **create training instructions**. The editing model itself takes the instruction and CAD sequence, not an image, at inference.

## How the editor works

1. **Locate:** An LLM receives the original sequence and instruction. It outputs a copy of the sequence with `<mask>` in positions that need modification, leaving unchanged portions intact. Training targets for this stage come from the longest common subsequence (LCS) between original and edited sequences: tokens outside the shared subsequence become masks, including placeholders for insertions. Adjacent masks are merged.
2. **Infill:** A second LLM stage receives the instruction, original sequence, and predicted masked sequence. It generates the final edited sequence by filling in the changes while using the unmasked content as context.
3. **Refine:** Both stages use LoRA fine-tuning. The infilling stage is first trained on synthetic examples. The authors then generate several candidate edits, render them, ask people to select the best result, and fine-tune on this selected dataset.

The reported backbone is Llama-3-8B-Instruct. At inference, the locating stage runs first and its predicted mask is passed to the infilling stage.

## Practical interpretation and limits

The explicit mask makes the edit location visible and gives the infiller a strong signal about what should be preserved. It does not guarantee an unchanged region will remain geometrically identical after the full sequence is regenerated. The authors cite the cost and fallibility of vision-language data synthesis and the difficulty of long CAD sequences as limitations.

## Sources

- [Paper, data synthesis and locate-then-infill method](https://arxiv.org/html/2502.03997v2)
- [Official implementation](https://github.com/microsoft/CAD-Editor)
