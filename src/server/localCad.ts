import type { AppUIMessage } from '@shared/chatAi';
import { imageIdFromFilename, imageStoragePath } from '@shared/imageRefs';
import { asParametricParts, isParametricArtifact } from '@shared/parametricParts';
import type { Message } from '@shared/types';
import { json, methodNotAllowed, preflight } from './api';
import { artifactOps } from '@shared/cadOps';
import { env } from './env';
import {
  CLAUDE_CODE_MODEL_ID,
  generateWithClaudeCode,
  parseProvider,
} from './localCadClaude';
import { editCadSequence, generateCadSequence, llmConfigured, llmModelId } from './localCadLlm';
import { requestRender, type LoadFile, type LoadVersion } from './localCadRender';
import { getAnonSupabaseClient } from './supabaseClient';

type CadArtifact = Extract<
  AppUIMessage['parts'][number],
  { type: 'data-cad-artifact' }
>['data'];

const endpoints = {
  fusion: () => env('CAD_FUSION_URL') || 'http://127.0.0.1:18082',
  editor: () => env('CAD_EDITOR_URL') || 'http://127.0.0.1:18083',
  coder: () => env('CAD_CODER_URL') || 'http://127.0.0.1:18081',
};

function latestArtifact(rows: Message[], leaf: Message) {
  const byId = new Map(rows.map((row) => [row.id, row]));
  let parentId = leaf.parent_message_id;
  while (parentId) {
    const row = byId.get(parentId);
    if (!row) break;
    const parts = asParametricParts(row.parts);
    for (let i = parts.length - 1; i >= 0; i--) {
      const part = parts[i];
      if (part.type === 'data-cad-artifact') return part.data;
      if (
        part.type === 'tool-build_parametric_model' &&
        part.state !== 'input-streaming' &&
        isParametricArtifact(part.input)
      ) {
        return { sourceFormat: 'openscad' as const };
      }
    }
    parentId = row.parent_message_id;
  }
  return null;
}

async function callModel(
  baseUrl: string,
  path: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(240_000),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    throw new Error(`CAD model returned ${response.status}: ${detail}`);
  }
  const value: unknown = await response.json();
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('CAD model returned an invalid response');
  }
  return value as Record<string, unknown>;
}

function requiredOutput(value: unknown, key: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`CAD model returned no ${key}`);
  }
  return value.trim();
}

export async function handleLocalCadRequest(request: Request): Promise<Response> {
  if (request.method === 'OPTIONS') return preflight();
  if (request.method !== 'POST') return methodNotAllowed();

  const client = getAnonSupabaseClient({
    global: {
      headers: { Authorization: request.headers.get('Authorization') ?? '' },
    },
  });
  const { data: auth } = await client.auth.getUser();
  if (!auth.user) return json({ error: 'Unauthorized' }, 401);

  const body: unknown = await request.json().catch(() => null);
  const conversationId =
    body && typeof body === 'object' && 'conversationId' in body
      ? body.conversationId
      : null;
  if (typeof conversationId !== 'string') {
    return json({ error: 'Missing conversationId' }, 400);
  }

  const { data: conversation } = await client
    .from('conversations')
    .select('id,user_id,type,title,current_message_leaf_id')
    .eq('id', conversationId)
    .eq('user_id', auth.user.id)
    .single();
  if (!conversation || conversation.type !== 'parametric') {
    return json({ error: 'CAD conversation not found' }, 404);
  }

  const { data: rows, error: rowsError } = await client
    .from('messages')
    .select('*')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true })
    .overrideTypes<Message[]>();
  if (rowsError || !rows) return json({ error: 'Could not load messages' }, 500);

  const provider = parseProvider(
    body && typeof body === 'object' && 'provider' in body ? body.provider : null,
  );
  const leaf = rows.find((row) => row.id === conversation.current_message_leaf_id);
  if (!leaf || leaf.role !== 'user') {
    return json({ error: 'No user request is pending' }, 409);
  }
  const existing = rows.find(
    (row) => row.parent_message_id === leaf.id && row.role === 'assistant',
  );
  if (existing) return json({ messageId: existing.id, reused: true });

  const parts = asParametricParts(leaf.parts);
  const instruction = parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
    .trim();
  const imagePart = parts.find(
    (part) => part.type === 'file' && part.mediaType.startsWith('image/'),
  );
  // Titles come from the user's own line, not the appended selection context.
  const headline = instruction.split('\n')[0];
  const previous = latestArtifact(rows, leaf);
  let artifact: CadArtifact;
  const loadFile: LoadFile = async (path) => {
    // Files live under the owner's folder, so one user cannot render another's.
    if (!path.startsWith(`${auth.user.id}/`)) return null;
    const { data: file } = await client.storage.from('meshes').download(path);
    return file ? Buffer.from(await file.arrayBuffer()) : null;
  };
  const loadVersion: LoadVersion = async (id) => {
    const row = rows.find((candidate) => candidate.id === id);
    const found = row ? asParametricParts(row.parts).find((item) => item.type === 'data-cad-artifact') : null;
    return found && found.type === 'data-cad-artifact' ? found.data : null;
  };
  const importPart = parts.find((part) => part.type === 'data-cad-import');
  const opParts = parts.flatMap((part) => (part.type === 'data-cad-op' ? [part.data] : []));

  try {
    if (importPart?.type === 'data-cad-import') {
      // An uploaded STEP/STL becomes the first version; no model is involved.
      const { path, filename, format } = importPart.data;
      if (!path.startsWith(`${auth.user.id}/`) || (format !== 'step' && format !== 'stl')) {
        return json({ error: 'Invalid import.' }, 400);
      }
      artifact = {
        sourceFormat: format,
        source: `storage:${path}`,
        modelId: 'Imported file',
        title: filename.slice(0, 80),
        version: 'v1',
      };
      const check = await requestRender(artifact, loadFile, undefined, loadVersion);
      if (!check.ok) return json({ error: check.error }, check.status);
    } else if (opParts.length > 0) {
      // Cuts and drilled holes are deterministic geometry, not model requests.
      if (!previous || previous.sourceFormat === 'openscad' || !('source' in previous)) {
        return json({ error: 'There is no CAD model to modify yet.' }, 422);
      }
      artifact = {
        ...previous,
        ops: [...artifactOps(previous), ...opParts].slice(-24),
        cuts: undefined,
        title: headline.slice(0, 80) || previous.title,
      };
      // Refuse an operation that cannot be rendered, so history never holds one.
      const check = await requestRender(artifact, loadFile, undefined, loadVersion);
      if (!check.ok) return json({ error: check.error }, check.status);
    } else if (imagePart?.type === 'file') {
      const imageId = imageIdFromFilename(imagePart.filename);
      if (!imageId) return json({ error: 'Image reference is missing' }, 400);
      const { data: file, error: fileError } = await client.storage
        .from('images')
        .download(imageStoragePath(auth.user.id, conversationId, imageId));
      if (fileError || !file) return json({ error: 'Could not load image' }, 422);
      const imageBase64 = Buffer.from(await file.arrayBuffer()).toString('base64');
      const result = await callModel(endpoints.coder(), '/generate', {
        image_base64: imageBase64,
        ...(instruction ? { prompt: instruction } : {}),
      });
      artifact = {
        sourceFormat: 'cadquery',
        source: requiredOutput(result.code, 'CadQuery code'),
        modelId: 'CADCODER/CAD-Coder',
        title: headline.slice(0, 80) || 'Image reconstruction',
        version: 'v1',
      };
    } else if (
      provider === 'claude-code' &&
      (!previous || previous.sourceFormat === 'cad-sequence' || previous.sourceFormat === 'cadquery')
    ) {
      if (!instruction) return json({ error: 'Enter a CAD description' }, 400);
      artifact = {
        sourceFormat: 'cadquery',
        source: await generateWithClaudeCode(
          instruction,
          previous && 'source' in previous ? previous : undefined,
        ),
        modelId: CLAUDE_CODE_MODEL_ID,
        title: headline.slice(0, 80) || previous?.title || 'Claude Code model',
        version: 'v1',
        // A command sequence is rebuilt from scratch, so its earlier ops (which point
        // at that geometry) do not apply; ops on CadQuery source stay applied.
        ...(previous?.sourceFormat === 'cadquery' && artifactOps(previous).length > 0
          ? { ops: artifactOps(previous) }
          : {}),
      };
      // Only keep code the renderer can build, so history never holds a broken model.
      const check = await requestRender(artifact, loadFile, undefined, loadVersion);
      if (!check.ok) {
        return json({ error: `Claude Code's model did not build: ${check.error}` }, 422);
      }
    } else if (previous?.sourceFormat === 'cad-sequence') {
      if (!instruction) return json({ error: 'Enter an edit instruction' }, 400);
      const useLlm = llmConfigured();
      const edited = useLlm
        ? await editCadSequence(instruction, previous.source)
        : requiredOutput(
            (
              await callModel(endpoints.editor(), '/edit', {
                original_sequence: previous.source,
                instruction,
              })
            ).sequence,
            'edited CAD sequence',
          );
      artifact = {
        sourceFormat: 'cad-sequence',
        source: edited,
        modelId: useLlm ? llmModelId() : 'microsoft/CAD-Editor',
        title: headline.slice(0, 80),
        version: 'v1',
        // Earlier cuts and holes stay applied on top of the edited model.
        ...(artifactOps(previous).length > 0 ? { ops: artifactOps(previous) } : {}),
      };
      if (useLlm || artifact.ops) {
        const check = await requestRender(artifact, loadFile, undefined, loadVersion);
        if (!check.ok) {
          return json(
            {
              error: useLlm && !artifact.ops
                ? `The model's edit did not produce a valid solid (${check.error}). Try rephrasing the instruction.`
                : `The edit no longer works with your earlier cuts or holes: ${check.error}`,
            },
            422,
          );
        }
      }
    } else if (previous) {
      return json(
        {
          error:
            previous.sourceFormat === 'step' || previous.sourceFormat === 'stl'
              ? 'Imported files are changed with exact operations (cut, hole, fillet, scale, ...). Describe the operation using the selection.'
              : `This model cannot edit ${previous.sourceFormat} source. Attach an image to start a new CadQuery reconstruction.`,
        },
        422,
      );
    } else {
      if (!instruction) return json({ error: 'Enter a CAD description' }, 400);
      if (llmConfigured()) {
        artifact = {
          sourceFormat: 'cad-sequence',
          source: await generateCadSequence(instruction),
          modelId: llmModelId(),
          title: headline.slice(0, 80),
          version: 'v1',
        };
      } else {
        const result = await callModel(endpoints.fusion(), '/generate', {
          description: instruction,
        });
        artifact = {
          sourceFormat: 'cad-sequence',
          source: requiredOutput(result.sequence, 'CAD sequence'),
          modelId: 'microsoft/CADFusion',
          title: headline.slice(0, 80),
          version: 'v1',
        };
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'CAD model failed';
    return json({ error: message }, 502);
  }

  const assistantId = crypto.randomUUID();
  const assistantParts: AppUIMessage['parts'] = [
    {
      type: 'text',
      text: importPart
        ? `Imported ${artifact.title}.`
        : opParts.length > 0
        ? `Applied ${opParts.length === 1 ? 'the operation' : `${opParts.length} operations`} to the ${artifact.sourceFormat} model.`
        : `${artifact.modelId} generated ${artifact.sourceFormat} source.`,
    },
    { type: 'data-cad-artifact', data: artifact },
  ];
  const { error: insertError } = await client.from('messages').insert({
    id: assistantId,
    conversation_id: conversationId,
    parent_message_id: leaf.id,
    role: 'assistant',
    parts: JSON.parse(JSON.stringify(assistantParts)),
    metadata: { model: artifact.modelId },
  });
  if (insertError) return json({ error: 'Could not save CAD result' }, 500);

  if (conversation.title === 'New Conversation') {
    await client
      .from('conversations')
      .update({ title: artifact.title })
      .eq('id', conversationId)
      .eq('user_id', auth.user.id);
  }
  return json({ messageId: assistantId, artifact });
}
