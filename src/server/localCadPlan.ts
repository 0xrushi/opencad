import { json, methodNotAllowed, preflight } from './api';
import { env } from './env';
import { getAnonSupabaseClient } from './supabaseClient';

/** Forward a request and the selected geometry to the self-hosted planner. */
export async function handleLocalCadPlan(request: Request): Promise<Response> {
  if (request.method === 'OPTIONS') return preflight();
  if (request.method !== 'POST') return methodNotAllowed();

  const client = getAnonSupabaseClient({
    global: { headers: { Authorization: request.headers.get('Authorization') ?? '' } },
  });
  const { data: auth } = await client.auth.getUser();
  if (!auth.user) return json({ error: 'Unauthorized' }, 401);

  const body: unknown = await request.json().catch(() => null);
  if (
    !body ||
    typeof body !== 'object' ||
    !('instruction' in body) ||
    typeof body.instruction !== 'string' ||
    !body.instruction.trim()
  ) {
    return json({ error: 'Missing instruction' }, 400);
  }
  const context =
    'context' in body && typeof body.context === 'string' ? body.context.slice(0, 6000) : '';

  const url = (env('CAD_PLANNER_URL') || 'http://127.0.0.1:18085').replace(/\/$/, '');
  try {
    const response = await fetch(`${url}/plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instruction: body.instruction.trim().slice(0, 1500), context }),
      signal: AbortSignal.timeout(60_000),
    });
    if (response.status === 422) {
      // The planner answered but could not produce a valid plan: ask the user
      // to rephrase rather than guessing or falling back to keyword routing.
      return json({
        intent: 'clarify',
        ops: [],
        message:
          'I could not turn that into exact operations. Name the faces or edges and give each distance, for example "cut through the two selected edges, shifted 0.05 to the left".',
      });
    }
    if (!response.ok) return json({ error: 'The planner is unavailable.' }, 502);
    return json(await response.json());
  } catch {
    return json({ error: 'The planner is unavailable.' }, 502);
  }
}
