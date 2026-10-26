# CAD-Coder: An Open-Source Vision-Language Model for Computer-Aided Design Code Generation

**Task:** Reconstruct an editable 3D CAD program from an object image.  
**Input:** Image, primarily an isometric rendering in the training and main evaluation setup.  
**Output:** Executable CadQuery Python that constructs a solid.  
**Paper:** [arXiv:2505.14646](https://arxiv.org/abs/2505.14646).  
**Code:** [anniedoris/CAD-Coder](https://github.com/anniedoris/CAD-Coder).

## Why it exists

Many image-to-3D systems output only geometry. CAD-Coder instead predicts **source code** that can be executed, inspected, and edited. Its target language is CadQuery Python, so it differs from systems that predict a special-purpose sketch-and-extrusion token stream.

## How it works

1. **Make image–code pairs.** The authors start with GenCAD CAD programs and their rendered isometric images. They translate each construction command into CadQuery Python. The underlying command types are sketch line, sketch arc, sketch circle, and extrude. The resulting GenCAD-Code dataset contains 163,671 scripts, each associated with five rendered views; stage-two training uses the unscaled isometric view.
2. **Assemble a vision-language model.** The architecture follows LLaVA 1.5: a CLIP-ViT-L-336px image encoder, a two-layer MLP projection, and a Vicuna-13B-v1.5 language model.
3. **Align visual features.** In stage one, the image encoder and language model are frozen while the MLP learns to map image features into the language model's embedding space. This stage uses the general LLaVA image-caption pretraining data.
4. **Train for CAD code.** In stage two, the image and a fixed code-generation instruction are paired with the reference CadQuery script. The vision encoder stays frozen; the MLP and language model are supervised to predict the script autoregressively. The training split contains 147,289 examples, with a small number of overlength cases filtered out.
5. **Execute the result.** At inference, the generated Python script is run in a CadQuery environment to produce a solid. The project supplies a separate evaluation pipeline for code validity, STEP generation, and geometric comparison.

Because the training scripts come from a direct command conversion, the generated code may be verbose. For example, a rectangle can be built from four line commands instead of CadQuery's shorter `.rect()` operation.

## Evidence and limits

The paper evaluates code validity and shape similarity on a **100-example subset** of the GenCAD-Code test set. Its reported 100% valid syntax rate applies to that subset, not arbitrary images. Shape accuracy is measured with best-aligned solid intersection-over-union after normalizing scale and translation. The authors show small real-photo experiments, but note that perspective and exact dimension recovery remain difficult; unseen CAD operations are also prompt-sensitive.

## Sources

- [Paper, dataset, architecture, training, and evaluation](https://arxiv.org/html/2505.14646v1)
- [Official implementation and inference instructions](https://github.com/anniedoris/CAD-Coder)
