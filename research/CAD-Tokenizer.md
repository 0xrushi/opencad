# CAD-Tokenizer: Towards Text-based CAD Prototyping via Modality-Specific Tokenization

**Task:** Generate a parametric CAD construction sequence from text, or edit an existing sequence using a text instruction.  
**Input:** Instruction and, for editing, an optional original CAD sequence.  
**Output:** A new sketch-and-extrusion CAD sequence.  
**Paper:** [arXiv:2509.21150](https://arxiv.org/abs/2509.21150) (ICLR 2026 version).

## Why it exists

Earlier LLM-based CAD systems serialized construction operations as text and passed them through a general-purpose word tokenizer. A single line, arc, or extrusion could then become many unrelated word pieces. CAD-Tokenizer instead learns discrete tokens organized around CAD primitives, so the language model sees a shorter sequence with more meaningful geometric units.

The paper calls the combined generation and editing task **text-based CAD prototyping**: an instruction plus an optional existing CAD sequence maps to a generated sequence. An absent existing sequence means text-to-CAD; a present one means editing.

## How it works

1. **Prepare construction sequences.** CAD data is represented as sketch-and-extrusion operations. The tokenizer groups the sequence into sketch–extrusion pairs and smaller primitives within them.
2. **Learn CAD tokens.** A transformer-based VQ-VAE encodes the sequence. Primitive-specific pooling produces several latent vectors per sketch–extrusion pair, instead of compressing an entire model into one vector. Vector quantization maps those vectors to discrete codebook entries. A decoder reconstructs the CAD sequence; reconstruction and VQ losses train this stage.
3. **Align tokens with the LLM.** Two adapters map between VQ-VAE vectors and the pretrained LLM's embedding space. The paper trains these adapters while freezing the tokenizer and the LLM embedding/logit layers. The resulting primitive IDs can be used with the LLM vocabulary without training the whole backbone during alignment.
4. **Instruction tune.** The original CAD sequence, when present, and the target CAD sequence are encoded with the learned tokenizer. The LLM is fine-tuned with next-token cross-entropy on both text-to-CAD and editing examples. The reported implementation uses LLaMA-3-8B with LoRA.
5. **Constrain generation.** At inference, a finite-state automaton tracks the CAD grammar and masks invalid next-token choices. The generated primitive tokens are decoded back into a construction sequence.

The finite-state automaton enforces **sequence syntax**. It does not prove that the resulting geometry is feasible or matches the instruction.

## Training data and reported setup

- The VQ-VAE is trained on converted SkexGen sequences. The authors use half of the training data for this stage so the language model also sees CAD examples the tokenizer did not train on.
- LLM instruction tuning combines the CADFusion text-to-CAD data with CAD-Editor editing data, balanced at about five editing examples per text-to-CAD example. The paper reports roughly 100,000 training pairs and 1,000 test pairs.
- The reported VQ-VAE uses a 2,048-entry codebook and 512-dimensional internal representation. The LLM stage uses LoRA with rank 32 and a 1,024-token maximum length.

## Practical interpretation and limits

Its key contribution is the **representation layer**: compact primitive-aware tokens plus grammar-aware decoding. This can support both new design and editing in one model. It still relies on the sequence format and training distribution; the authors identify complex CAD data, spatial reasoning, and editing metrics that account for preserving the original shape as remaining limitations.

As of October 2026, the [official repository](https://github.com/rwang37/CAD-Tokenizer) contains a README stating that code is still being prepared, and the [Hugging Face paper page](https://huggingface.co/papers/2509.21150) links no model checkpoint. A production integration therefore needs a later release or a validated reproduction.

## Sources

- [Paper, methodology and experiments](https://arxiv.org/html/2509.21150v2)
- [Paper abstract and version history](https://arxiv.org/abs/2509.21150)
