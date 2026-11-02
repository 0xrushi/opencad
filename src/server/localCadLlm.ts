import { env } from './env';

/** True when an OpenAI-compatible CAD model (e.g. llama-swap) is configured. */
export function llmConfigured(): boolean {
  return Boolean(env('CAD_LLM_URL'));
}

export function llmModelId(): string {
  return env('CAD_LLM_MODEL') || 'cad-plaintext';
}

async function complete(prompt: string): Promise<string> {
  const base = env('CAD_LLM_URL').replace(/\/$/, '').replace(/\/v1$/, '');
  const apiKey = env('CAD_LLM_API_KEY');
  const response = await fetch(`${base}/v1/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: llmModelId(),
      temperature: 0,
      max_tokens: 1024,
      prompt,
    }),
    // llama-swap may need to load the model first.
    signal: AbortSignal.timeout(300_000),
  });
  if (!response.ok) {
    throw new Error(
      `CAD model returned ${response.status}: ${(await response.text()).slice(0, 300)}`,
    );
  }
  const data: unknown = await response.json();
  const text = (data as { choices?: { text?: unknown }[] })?.choices?.[0]?.text;
  if (typeof text !== 'string' || !text.includes('<extrude_end>')) {
    throw new Error('CAD model returned no CAD sequence');
  }
  return text.trim();
}

/**
 * The model is a base Llama-3 + LoRA served by llama-swap: a completion model
 * with no chat template, so it needs raw /v1/completions and fixed prompts.
 */
export function generateCadSequence(description: string): Promise<string> {
  return complete(
    'Below is a description of a 3D shape:\n' +
      description +
      '\nGenerate a Computer-Aided Design(CAD) command sequence of the 3D shape:\n',
  );
}

/** Edit an existing CAD command sequence; returns the full edited sequence. */
export function editCadSequence(instruction: string, source: string): Promise<string> {
  return complete(
    `Task: CAD editing\nInstruction: ${instruction}\nOriginal CAD:\n${source}\nOutput CAD:\n`,
  );
}
