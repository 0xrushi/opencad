import type { AppUIMessage, CadOp } from '@shared/chatAi';
import { artifactOps } from '@shared/cadOps';
import { asParametricParts } from '@shared/parametricParts';
import type { Message } from '@shared/types';
import { json, methodNotAllowed, preflight } from './api';
import { env } from './env';
import { getAnonSupabaseClient } from './supabaseClient';

// The renderer reports `{detail}` with library noise ahead of the real error.
async function renderFailure(response: Response): Promise<string> {
  const text = await response.text();
  let detail = text;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && 'detail' in parsed && typeof parsed.detail === 'string') {
      detail = parsed.detail;
    }
  } catch {
    // Not JSON; use the raw text.
  }
  const lines = detail.split('\n').map((line) => line.trim()).filter(Boolean);
  return (lines.at(-1) ?? 'unknown error').slice(0, 200);
}

type CadArtifactData = Extract<
  AppUIMessage['parts'][number],
  { type: 'data-cad-artifact' }
>['data'];

/** Reads an uploaded file's bytes, given its `storage:<path>` source. */
export type LoadFile = (path: string) => Promise<Buffer | null>;

/** Finds another saved version (a message id) of the same conversation. */
export type LoadVersion = (messageId: string) => Promise<CadArtifactData | null>;

const MAX_IMPORT_BYTES = 25 * 1024 * 1024;

/** Ask the renderer for geometry; `error` is a short, user-readable reason. */
export async function requestRender(
  data: CadArtifactData,
  loadFile?: LoadFile,
  /** Preview: return only the faces `fill` would remove, applied after the saved ops. */
  preview?: Extract<CadOp, { type: 'fill' | 'remove' | 'delete' }>,
  loadVersion?: LoadVersion,
  depth = 0,
): Promise<
  { ok: true; body: unknown } | { ok: false; error: string; status: number }
> {
  const url = (env('CAD_RENDER_URL') || 'http://127.0.0.1:18084').replace(/\/$/, '');
  let sourceBase64: string | undefined;
  if (data.sourceFormat === 'step' || data.sourceFormat === 'stl') {
    const path = data.source.replace(/^storage:/, '');
    const file = loadFile ? await loadFile(path) : null;
    if (!file) return { ok: false, error: 'The imported file could not be loaded.', status: 422 };
    if (file.length > MAX_IMPORT_BYTES) {
      return { ok: false, error: 'The imported file is larger than 25 MB.', status: 422 };
    }
    sourceBase64 = file.toString('base64');
  }
  // A combine op names another version; render that one first and hand its STEP over.
  const ops: unknown[] = [];
  for (const op of artifactOps(data)) {
    if (op.type !== 'combine') {
      ops.push(op);
      continue;
    }
    const other = depth < 3 ? await loadVersion?.(op.versionId) : null;
    if (!other) {
      return { ok: false, error: 'The version to combine with could not be found.', status: 422 };
    }
    const rendered = await requestRender(other, loadFile, undefined, loadVersion, depth + 1);
    if (!rendered.ok) return rendered;
    const stepBase64 = (rendered.body as { stepBase64?: string }).stepBase64;
    if (!stepBase64) {
      return { ok: false, error: 'The version to combine with has no solid geometry.', status: 422 };
    }
    ops.push({ ...op, other_step: stepBase64 });
  }
  try {
    const response = await fetch(`${url}/render`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceFormat: data.sourceFormat,
        source: sourceBase64 ? '' : data.source,
        ...(sourceBase64 ? { sourceBase64 } : {}),
        ops: preview ? [...ops, preview] : ops,
        ...(preview ? { preview: true } : {}),
      }),
      signal: AbortSignal.timeout(70_000),
    });
    if (!response.ok) {
      return {
        ok: false,
        error: `CAD render failed: ${await renderFailure(response)}`,
        status: 422,
      };
    }
    return { ok: true, body: await response.json() };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'CAD renderer unavailable',
      status: 502,
    };
  }
}

export async function handleLocalCadRender(request: Request): Promise<Response> {
  if (request.method === 'OPTIONS') return preflight();
  if (request.method !== 'POST') return methodNotAllowed();
  const client = getAnonSupabaseClient({
    global: { headers: { Authorization: request.headers.get('Authorization') ?? '' } },
  });
  const { data: auth } = await client.auth.getUser();
  if (!auth.user) return json({ error: 'Unauthorized' }, 401);
  const body: unknown = await request.json().catch(() => null);
  if (!body || typeof body !== 'object' || !('messageId' in body) || typeof body.messageId !== 'string') {
    return json({ error: 'Missing messageId' }, 400);
  }
  const { data: message } = await client
    .from('messages')
    .select('*')
    .eq('id', body.messageId)
    .single()
    .overrideTypes<Message>();
  if (!message) return json({ error: 'CAD artifact not found' }, 404);
  const { data: conversation } = await client
    .from('conversations')
    .select('id')
    .eq('id', message.conversation_id)
    .eq('user_id', auth.user.id)
    .single();
  if (!conversation) return json({ error: 'CAD artifact not found' }, 404);
  const part = asParametricParts(message.parts).find((item) => item.type === 'data-cad-artifact');
  if (!part || part.type !== 'data-cad-artifact') return json({ error: 'No renderable CAD artifact' }, 422);
  const points =
    'previewFill' in body && Array.isArray(body.previewFill)
      ? (body.previewFill as unknown[]).filter(
          (point): point is [number, number, number] =>
            Array.isArray(point) &&
            point.length === 3 &&
            point.every((value) => typeof value === 'number' && Number.isFinite(value)),
        )
      : null;
  const result = await requestRender(
    part.data,
    async (path) => {
      if (!path.startsWith(`${auth.user.id}/`)) return null;
      const { data: file } = await client.storage.from('meshes').download(path);
      return file ? Buffer.from(await file.arrayBuffer()) : null;
    },
    points && points.length > 0
      ? {
          type:
            'previewType' in body && (body.previewType === 'remove' || body.previewType === 'delete')
              ? body.previewType
              : 'fill',
          points: points.slice(0, 24),
        }
      : undefined,
    async (id) => {
      const { data: row } = await client
        .from('messages')
        .select('*')
        .eq('id', id)
        .eq('conversation_id', message.conversation_id)
        .single()
        .overrideTypes<Message>();
      const found = row ? asParametricParts(row.parts).find((item) => item.type === 'data-cad-artifact') : null;
      return found && found.type === 'data-cad-artifact' ? found.data : null;
    },
  );
  return result.ok ? json(result.body) : json({ error: result.error }, result.status);
}
