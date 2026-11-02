import { env } from './env';

/** Where CAD requests are sent: the self-hosted model or the local Claude Code CLI. */
export type CadProvider = 'cad-plaintext' | 'claude-code';

export function parseProvider(value: unknown): CadProvider {
  return value === 'claude-code' ? 'claude-code' : 'cad-plaintext';
}

export const CLAUDE_CODE_MODEL_ID = 'Claude Code';

// The renderer runs CadQuery in a sandbox: straight-line code only.
const SYSTEM_PROMPT = [
  'You write CadQuery (Python) for a single solid part, in millimetres.',
  'Reply with only code: no prose and no markdown fences.',
  'Start with `import cadquery as cq` and assign the final solid to a variable named `result`.',
  'The code runs in a restricted sandbox: only straight-line code made of assignments, calls,',
  'attribute access, arithmetic, lists, tuples and indexing. No loops, if, def, lambda,',
  'comprehensions, f-strings, `with`, or imports other than cadquery. No Python built-ins',
  '(no range, len, abs, float, print). `math` is available (math.pi, math.sin ...).',
  'Express repeated features with CadQuery itself, for example pushPoints, polarArray or rarray.',
].join(' ');

/** Run `claude -p` with every tool disabled and return its stdout. */
async function runClaude(prompt: string): Promise<string> {
  // Anyone who can reach this endpoint would spend the owner's Claude Code,
  // so it is available to local development only.
  if (env('ENVIRONMENT') !== 'local') {
    throw new Error('Claude Code is only available when ENVIRONMENT is "local".');
  }
  const { spawn } = await import('node:child_process');
  const { tmpdir } = await import('node:os');
  return new Promise((resolve, reject) => {
    const child = spawn(
      env('CLAUDE_CODE_BIN') || 'claude',
      [
        '-p',
        '--tools',
        '',
        '--no-session-persistence',
        '--system-prompt',
        SYSTEM_PROMPT,
        ...(env('CLAUDE_CODE_MODEL') ? ['--model', env('CLAUDE_CODE_MODEL')] : []),
      ],
      // A neutral folder keeps this project's own CLAUDE.md out of the prompt.
      { cwd: tmpdir(), stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Claude Code timed out'));
    }, 180_000);
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (err += chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`Could not start Claude Code: ${error.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && out.trim()) resolve(out);
      else reject(new Error(`Claude Code failed (${code}): ${(err || out).slice(0, 300)}`));
    });
    child.stdin.end(prompt);
  });
}

/** Strip markdown fences and surrounding prose. */
export function extractCode(text: string): string {
  const fenced = text.match(/```(?:python|py)?\s*\n([\s\S]*?)```/i);
  return (fenced ? fenced[1] : text).trim();
}

/**
 * Generate or edit CadQuery source through Claude Code. `previous` is the model
 * being edited; a command sequence is given as context only, since Claude Code
 * rebuilds it in CadQuery.
 */
export async function generateWithClaudeCode(
  instruction: string,
  previous?: { sourceFormat: string; source: string },
): Promise<string> {
  let prompt = instruction;
  if (previous?.sourceFormat === 'cadquery') {
    prompt = `Current CadQuery code:\n${previous.source}\n\nChange it as follows and return the full updated code:\n${instruction}`;
  } else if (previous?.sourceFormat === 'cad-sequence') {
    prompt =
      `The current part is a CAD command sequence (sketch coordinates and extents are quantized to 0-63 and normalised):\n${previous.source}\n\n` +
      `Rebuild that part in CadQuery, then apply this change and return the full code:\n${instruction}`;
  }
  const code = extractCode(await runClaude(prompt));
  if (!code.includes('cq.') && !code.includes('cadquery')) {
    throw new Error('Claude Code did not return CadQuery code');
  }
  return code;
}
