import { OpenSCADPreview } from '@/components/viewer/OpenSCADViewer';
import { CadSelectViewer } from '@/components/viewer/CadSelectViewer';
import {
  buildTopology,
  describeSelection,
  planeFromSelection,
  selectionKey,
  type CadSelection,
  type CadTopology,
} from '@/lib/cadTopology';
import { useAuth } from '@/contexts/AuthContext';
import { useConversation } from '@/contexts/ConversationContext';
import { apiJson } from '@/services/api';
import { ensureInputRecords } from '@/lib/aiMessages';
import { imageFilePartUrl, imageStoragePath } from '@shared/imageRefs';
import { asParametricParts, isParametricArtifact } from '@shared/parametricParts';
import type { AppUIMessage, CadOp } from '@shared/chatAi';
import type { Message } from '@shared/types';
import { persistUserMessage, useMessagesQuery } from '@/services/messageService';
import { supabase } from '@/lib/supabase';
import { ImagePlus, Redo2, Trash2, Undo2, X } from 'lucide-react';
import { branchTo, redoTarget, undoTarget } from '@/lib/cadHistory';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { Vector3, type BufferGeometry } from 'three';
import {
  buildPlanContext,
  convertUnits,
  describeMarker,
  describePlan,
  hasPhysicalUnits,
  measure,
  normalizeDirections,
  resolveMark,
  resolvePlan,
  type CadPlan,
  type Marker,
} from '@/lib/cadPlan';

// Verbs that mean "fill the selection" and nothing else.
const FILL_WORDS = /\b(fill|plug|seal|patch|close(?:\s+(?:up|off))?|make (?:it |this )?(?:solid|flush))\b/i;
const OTHER_OP_WORDS = /\b(cut|slice|split|drill|bore|fillet|chamfer|bevel|scale|resize|move|translate|mirror|stretch|extend|shrink|measure|marker)\b/i;
function wantsFillOnly(text: string): boolean {
  return FILL_WORDS.test(text) && !OTHER_OP_WORDS.test(text);
}

type SourceArtifact = {
  sourceFormat: 'cad-sequence' | 'cadquery' | 'openscad' | 'step' | 'stl';
  source: string;
  modelId: string;
  title: string;
};

type RenderResult = { stlBase64: string; stepBase64: string };

function artifactIn(message: Message): SourceArtifact | null {
  for (const part of asParametricParts(message.parts).reverse()) {
    if (part.type === 'data-cad-artifact') return part.data;
    if (
      part.type === 'tool-build_parametric_model' &&
      part.state !== 'input-streaming' &&
      isParametricArtifact(part.input)
    ) {
      return {
        sourceFormat: 'openscad',
        source: part.input.code,
        modelId: 'Legacy OpenSCAD',
        title: part.input.title,
      };
    }
  }
  return null;
}

export default function LocalCadEditor() {
  const { conversation } = useConversation();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { data: rows = [], isFetched } = useMessagesQuery();
  const branch = useMemo(
    () => branchTo(rows, conversation.current_message_leaf_id),
    [rows, conversation.current_message_leaf_id],
  );
  const [text, setText] = useState('');
  const [image, setImage] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [provider, setProvider] = useState<'cad-plaintext' | 'claude-code'>(() => {
    try {
      return localStorage.getItem('cadam.cadProvider') === 'claude-code' ? 'claude-code' : 'cad-plaintext';
    } catch {
      return 'cad-plaintext';
    }
  });
  // generate() runs from an effect; a ref keeps it from re-firing when the choice changes.
  const providerRef = useRef(provider);
  providerRef.current = provider;
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [renderResult, setRenderResult] = useState<RenderResult | null>(null);
  const [geometry, setGeometry] = useState<BufferGeometry | null>(null);
  const [topology, setTopology] = useState<CadTopology | null>(null);
  const [selection, setSelection] = useState<CadSelection[]>([]);
  // The preview is centred for display; cuts need the original shape's frame.
  const [answer, setAnswer] = useState<string | null>(null);
  const [marker, setMarker] = useState<Marker | null>(null);
  // A fill waits for confirmation while the faces it would remove glow red.
  const [pendingFill, setPendingFill] = useState<{
    op: Extract<CadOp, { type: 'fill' | 'remove' | 'delete' }>;
    description: string;
    geometry: BufferGeometry;
  } | null>(null);
  const [markerDepth, setMarkerDepth] = useState('');
  const [sizeInput, setSizeInput] = useState('');
  const [holeDiameter, setHoleDiameter] = useState('');
  const [holeDepth, setHoleDepth] = useState('');
  const [shapeCenter, setShapeCenter] = useState<Vector3 | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [rendering, setRendering] = useState(false);
  const imagePreview = useMemo(
    () => (image ? URL.createObjectURL(image) : null),
    [image],
  );
  useEffect(
    () => () => {
      if (imagePreview) URL.revokeObjectURL(imagePreview);
    },
    [imagePreview],
  );
  const attemptedLeaves = useRef(new Set<string>());

  const activeMessage =
    branch.find((message) => message.id === selectedId) ??
    [...branch].reverse().find((message) => artifactIn(message));
  const activeArtifact = activeMessage ? artifactIn(activeMessage) : null;

  useEffect(() => {
    if (!activeMessage || !activeArtifact || activeArtifact.sourceFormat === 'openscad') {
      setRenderResult(null);
      setGeometry(null);
      setTopology(null);
      setSelection([]);
      setMarker(null);
      setPendingFill(null);
      setRenderError(null);
      return;
    }
    let cancelled = false;
    setRendering(true);
    setRenderError(null);
    setRenderResult(null);
    setGeometry(null);
    setTopology(null);
    setSelection([]);
    setMarker(null);
    setPendingFill(null);
    void apiJson('local-cad-render', {
      method: 'POST',
      body: JSON.stringify({ messageId: activeMessage.id }),
    })
      .then((value) => {
        if (cancelled) return;
        const result = value as RenderResult;
        if (typeof result.stlBase64 !== 'string' || typeof result.stepBase64 !== 'string') {
          throw new Error('CAD renderer returned invalid output');
        }
        const binary = atob(result.stlBase64);
        const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
        const parsed = new STLLoader().parse(bytes.buffer);
        parsed.computeVertexNormals();
        parsed.computeBoundingBox();
        setShapeCenter(parsed.boundingBox?.getCenter(new Vector3()) ?? null);
        parsed.center();
        setTopology(buildTopology(parsed));
        setGeometry(parsed);
        setRenderResult(result);
      })
      .catch((cause) => {
        if (!cancelled) setRenderError(cause instanceof Error ? cause.message : 'CAD render failed');
      })
      .finally(() => {
        if (!cancelled) setRendering(false);
      });
    return () => { cancelled = true; };
  }, [activeMessage?.id, activeArtifact?.sourceFormat]);

  const hasVersion = useCallback(
    (message: Message) => artifactIn(message) !== null,
    [],
  );
  const undoRow = useMemo(
    () => undoTarget(rows, conversation.current_message_leaf_id, hasVersion),
    [rows, conversation.current_message_leaf_id, hasVersion],
  );
  const redoRow = useMemo(
    () => redoTarget(rows, conversation.current_message_leaf_id, hasVersion),
    [rows, conversation.current_message_leaf_id, hasVersion],
  );

  const moveToVersion = useCallback(
    async (target: Message | null) => {
      if (!target || busy) return;
      setError(null);
      setAnswer(null);
      const { error: moveError } = await supabase
        .from('conversations')
        .update({ current_message_leaf_id: target.id })
        .eq('id', conversation.id);
      if (moveError) {
        setError('Could not change version.');
        return;
      }
      setSelectedId(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['messages', conversation.id] }),
        queryClient.invalidateQueries({ queryKey: ['conversation', conversation.id] }),
      ]);
    },
    [busy, conversation.id, queryClient],
  );

  // Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z (or Ctrl+Y), except while typing.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT')) return;
      if (!(event.ctrlKey || event.metaKey)) return;
      const key = event.key.toLowerCase();
      if (key === 'z' && !event.shiftKey) {
        event.preventDefault();
        void moveToVersion(undoRow);
      } else if ((key === 'z' && event.shiftKey) || key === 'y') {
        event.preventDefault();
        void moveToVersion(redoRow);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [moveToVersion, undoRow, redoRow]);

  const plane = useMemo(
    () => (topology && selection.length > 0 ? planeFromSelection(topology, selection) : null),
    [topology, selection],
  );
  const drillFace = useMemo(() => {
    if (!topology || selection.length !== 1 || selection[0].kind !== 'face') return null;
    const face = topology.faces[selection[0].id];
    return face?.planar ? face : null;
  }, [topology, selection]);
  const defaultDiameter = topology ? Number((topology.size * 0.1).toPrecision(2)) : 0;
  const latestArtifactId = useMemo(
    () => [...branch].reverse().find((message) => artifactIn(message))?.id,
    [branch],
  );
  // Edits apply to the version on screen. Editing an older version starts a
  // new branch from it, like undoing to it first.
  const editParent = activeArtifact
    ? (activeMessage?.id ?? conversation.current_message_leaf_id)
    : conversation.current_message_leaf_id;
  // A new result is shown as soon as it arrives, even if an older version was open.
  useEffect(() => {
    setSelectedId(null);
  }, [latestArtifactId]);

  const versionIds = useMemo(
    () => branch.filter((message) => artifactIn(message)).map((message) => message.id),
    [branch],
  );

  const pick = useCallback((item: CadSelection | null, additive: boolean) => {
    setSelection((current) => {
      if (!item) return additive ? current : [];
      const key = selectionKey(item);
      const present = current.some((entry) => selectionKey(entry) === key);
      if (!additive) return present && current.length === 1 ? [] : [item];
      return present
        ? current.filter((entry) => selectionKey(entry) !== key)
        : [...current, item];
    });
  }, []);

  const generate = useCallback(
    async (leafId: string) => {
      if (attemptedLeaves.current.has(leafId)) return;
      attemptedLeaves.current.add(leafId);
      setBusy(true);
      setError(null);
      try {
        await apiJson('local-cad', {
          method: 'POST',
          body: JSON.stringify({ conversationId: conversation.id, provider: providerRef.current }),
        });
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['messages', conversation.id] }),
          queryClient.invalidateQueries({ queryKey: ['conversation', conversation.id] }),
          queryClient.invalidateQueries({ queryKey: ['conversations'] }),
        ]);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'CAD generation failed');
      } finally {
        setBusy(false);
      }
    },
    [conversation.id, queryClient],
  );

  useEffect(() => {
    if (!isFetched || busy) return;
    const leaf = branch.at(-1);
    if (leaf?.role === 'user') void generate(leaf.id);
  }, [branch, busy, generate, isFetched]);

  // Faces and edges can be deleted; corners cannot.
  const deletable = useMemo(() => selection.filter((item) => item.kind !== 'vertex'), [selection]);

  const deleteSelected = async () => {
    if (!topology || !shapeCenter || busy || deletable.length === 0) return;
    const resolved = resolvePlan(
      [{ op: 'remove', targets: deletable.map((item) => selectionKey(item)) }],
      topology,
      shapeCenter,
    );
    if ('error' in resolved) {
      setError(resolved.error);
      return;
    }
    const [op] = resolved.ops;
    if (op.type !== 'delete') return;
    await previewFill(op, `Delete ${deletable.map((item) => selectionKey(item)).join(', ')}`);
  };

  // Delete / Backspace deletes the selection, except while typing.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT')) return;
      if (event.key !== 'Delete' && event.key !== 'Backspace') return;
      if (deletable.length === 0) return;
      event.preventDefault();
      void deleteSelected();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deletable, topology, shapeCenter, busy, activeMessage?.id]);

  const send = async () => {
    if (!user?.id || busy || (!text.trim() && !image)) return;
    // Exact geometry (cuts, holes, fillets, ...) is planned by the self-hosted
    // planner and executed by the CAD kernel; only generative requests reach
    // the CAD models. Keyword routing below is a fallback if the planner is down.
    setAnswer(null);
    let plannerUnavailable = true;
    if (!image && topology && shapeCenter && text.trim()) {
      let instruction = text.trim();
      if (hasPhysicalUnits(instruction)) {
        if (!mmPerUnit) {
          setError(
            'Set the real length of the part\'s longest side (above the preview) so lengths like "5mm" can be converted.',
          );
          return;
        }
        instruction = convertUnits(instruction, mmPerUnit);
      }
      instruction = normalizeDirections(instruction);
      // "Fill/plug/close this" with a selection is always a fill of the
      // selection; it does not need the planner to work it out.
      if (selection.length > 0 && wantsFillOnly(instruction)) {
        const targets = selection
          .filter((item) => item.kind !== 'vertex')
          .map((item) => selectionKey(item));
        const resolved = resolvePlan([{ op: 'fill', targets }], topology, shapeCenter);
        if ('error' in resolved) {
          setError(resolved.error);
          return;
        }
        setText('');
        await previewFill(
          resolved.ops[0] as Extract<CadOp, { type: 'fill' }>,
          `${text.trim()}\n(fill ${targets.join(', ')})`,
        );
        return;
      }
      setBusy(true);
      setError(null);
      let plan: CadPlan | null = null;
      try {
        plan = (await apiJson('local-cad-plan', {
          method: 'POST',
          body: JSON.stringify({
            instruction,
            // Versions are only mentioned when the request is about them, so the list
            // does not distract the planner from ordinary edits.
            context: buildPlanContext(
              topology,
              selection,
              marker,
              /\b(versions?|previous|earlier|older|original|before)\b/i.test(instruction) ? versionIds.length : 0,
            ),
          }),
        })) as CadPlan;
      } catch {
        plan = null;
      }
      setBusy(false);
      if (plan?.intent === 'mark') {
        const placed = resolveMark(plan.mark, topology, selection);
        if ('error' in placed) {
          setError(placed.error);
          return;
        }
        setMarker(placed.marker);
        setText('');
        return;
      }
      if (plan?.intent === 'marker') {
        if (!marker) {
          setError('There is no marker yet. Ask me to draw one on a face first.');
          return;
        }
        setText('');
        if (plan.marker.action === 'clear') {
          setMarker(null);
          return;
        }
        await drillAtMarker(plan.marker.depth);
        return;
      }
      if (plan?.intent === 'measure') {
        setAnswer(measure(plan.measure, topology, mmPerUnit));
        setText('');
        return;
      }
      if (plan?.intent === 'clarify') {
        setError(plan.message || 'Could you be more specific about what to change?');
        return;
      }
      if (plan?.intent === 'ops') {
        const resolved = resolvePlan(plan.ops, topology, shapeCenter, mmPerUnit, versionIds);
        if ('error' in resolved) {
          setError(resolved.error);
          return;
        }
        setText('');
        const description = `${text.trim()}\n(${describePlan(plan.ops)})`;
        const [only] = resolved.ops;
        if (resolved.ops.length === 1 && (only.type === 'fill' || only.type === 'remove' || only.type === 'delete')) {
          await previewFill(only, description);
          return;
        }
        await applyOps(resolved.ops, description);
        return;
      }
      plannerUnavailable = plan === null;
    }
    // The CAD models cannot cut along a plane, so a typed cut request with a
    // plane selected is applied exactly instead; the halves are shown apart.
    if (
      plannerUnavailable &&
      !image &&
      drillFace &&
      /\b(drill|hole|bore)\b/i.test(text)
    ) {
      setText('');
      await applyHole();
      return;
    }
    const wantsCut = /\b(cut|slice|split|section|halve|bisect)\b/i.test(text);
    if (plannerUnavailable && !image && plane && wantsCut) {
      // Never hand a cut with a selection to the AI model: it would guess.
      if ('error' in plane) {
        setError(`Could not build a cutting plane from the selection: ${plane.error}`);
        return;
      }
      setText('');
      await applyCut('split');
      return;
    }
    if (
      !image &&
      (activeArtifact?.sourceFormat === 'step' || activeArtifact?.sourceFormat === 'stl')
    ) {
      setError(
        plannerUnavailable
          ? 'The planner is not reachable, so this request could not be turned into an exact operation. Try again in a moment.'
          : 'I could not turn that into an exact operation on the imported part. Select the faces or edges involved and say what to do, for example "fill this", "cut here", "drill a 5mm hole" or "fillet these edges 1mm".',
      );
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const parts: AppUIMessage['parts'] = [];
      const context =
        topology && selection.length > 0
          ? describeSelection(topology, selection)
          : '';
      if (text.trim()) {
        parts.push({
          type: 'text',
          text: context ? `${text.trim()}\n\n${context}` : text.trim(),
        });
      }
      if (image) {
        if (!image.type.startsWith('image/') || image.size > 10_000_000) {
          throw new Error('Choose an image smaller than 10 MB');
        }
        const imageId = crypto.randomUUID();
        const path = imageStoragePath(user.id, conversation.id, imageId);
        const { error: uploadError } = await supabase.storage
          .from('images')
          .upload(path, image, { contentType: image.type });
        if (uploadError) throw uploadError;
        parts.push({
          type: 'file',
          mediaType: image.type,
          filename: `${imageId}.${image.name.split('.').at(-1) || 'png'}`,
          url: imageFilePartUrl(user.id, conversation.id, imageId),
        });
      }
      await ensureInputRecords({ parts, conversationId: conversation.id, userId: user.id });
      const leafId = await persistUserMessage({
        conversationId: conversation.id,
        parts,
        metadata: {},
        parentMessageId: editParent,
      });
      setText('');
      setImage(null);
      setSelection([]);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['messages', conversation.id] }),
        queryClient.invalidateQueries({ queryKey: ['conversation', conversation.id] }),
      ]);
      setBusy(false);
      void generate(leafId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not send request');
      setBusy(false);
    }
  };

  // Real size of one model unit, so lengths like "5mm" can be converted.
  const mmPerUnit = useMemo(() => {
    const value = (conversation.settings as { mmPerUnit?: unknown } | null)?.mmPerUnit;
    return typeof value === 'number' && value > 0 ? value : null;
  }, [conversation.settings]);

  const saveRealSize = async () => {
    const millimetres = Number(sizeInput);
    if (!topology || !(millimetres > 0)) {
      setError('Enter the real length of the longest side in millimetres.');
      return;
    }
    const { error: saveError } = await supabase
      .from('conversations')
      .update({
        settings: {
          ...((conversation.settings as Record<string, unknown> | null) ?? {}),
          mmPerUnit: millimetres / topology.size,
        },
      })
      .eq('id', conversation.id);
    if (saveError) {
      setError('Could not save the real size.');
      return;
    }
    setSizeInput('');
    setError(null);
    await queryClient.invalidateQueries({ queryKey: ['conversation', conversation.id] });
  };

  const applyOps = async (ops: CadOp[], description: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const parts: AppUIMessage['parts'] = [
        { type: 'text', text: description },
        ...ops.map((op) => ({ type: 'data-cad-op' as const, data: op })),
      ];
      const leafId = await persistUserMessage({
        conversationId: conversation.id,
        parts,
        metadata: {},
        parentMessageId: editParent,
      });
      setSelection([]);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['messages', conversation.id] }),
        queryClient.invalidateQueries({ queryKey: ['conversation', conversation.id] }),
      ]);
      setBusy(false);
      void generate(leafId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not apply the operation');
      setBusy(false);
    }
  };

  const previewFill = async (
    op: Extract<CadOp, { type: 'fill' | 'remove' | 'delete' }>,
    description: string,
  ) => {
    if (!activeMessage || !shapeCenter) return;
    setBusy(true);
    setError(null);
    try {
      const value = (await apiJson('local-cad-render', {
        method: 'POST',
        body: JSON.stringify({ messageId: activeMessage.id, previewFill: op.points, previewType: op.type }),
      })) as RenderResult;
      const bytes = Uint8Array.from(atob(value.stlBase64), (character) => character.charCodeAt(0));
      const parsed = new STLLoader().parse(bytes.buffer);
      parsed.translate(-shapeCenter.x, -shapeCenter.y, -shapeCenter.z);
      setPendingFill({ op, description, geometry: parsed });
      setSelection([]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not find a cavity to fill');
    } finally {
      setBusy(false);
    }
  };

  const applyOp = (op: CadOp, description: string) => applyOps([op], description);

  const drillAtMarker = async (depth: number | null) => {
    if (!marker || !shapeCenter) return;
    if (depth !== null && !(depth > 0)) {
      setError('Enter a positive depth, or leave it blank to drill through.');
      return;
    }
    if (!marker.inside) {
      setError('The marker is outside the face outline. Ask me to move it (for example "move it 2cm further from the left edge") before drilling.');
      return;
    }
    const placed = marker;
    setMarker(null);
    await applyOps(
      [
        {
          type: 'hole',
          origin: placed.origin.clone().add(shapeCenter).toArray(),
          normal: placed.normal.toArray(),
          diameter: placed.diameter,
          depth,
        },
      ],
      `Drill a hole at the marker on F${placed.faceId} (${describeMarker(placed, mmPerUnit)}${depth === null ? ', through' : `, ${depth} deep`}).`,
    );
  };

  const applyCut = async (keep: 'positive' | 'negative' | 'split') => {
    if (!plane || 'error' in plane || !shapeCenter) return;
    const origin = plane.origin.clone().add(shapeCenter);
    const keepText =
      keep === 'split'
        ? 'splitting it into two halves'
        : `keeping the ${keep === 'positive' ? plane.positiveName : plane.negativeName} side`;
    await applyOp(
      {
        type: 'cut',
        origin: origin.toArray(),
        normal: plane.normal.toArray(),
        keep,
      },
      `Cut along ${plane.label}, ${keepText}.`,
    );
  };

  const applyHole = async () => {
    if (!drillFace || !shapeCenter) return;
    const diameter = Number(holeDiameter || defaultDiameter);
    const depth = holeDepth.trim() === '' ? null : Number(holeDepth);
    if (!(diameter > 0) || (depth !== null && !(depth > 0))) {
      setError('Enter a positive hole diameter, and a positive depth or leave it blank to drill through.');
      return;
    }
    await applyOp(
      {
        type: 'hole',
        origin: drillFace.center.clone().add(shapeCenter).toArray(),
        normal: drillFace.normal.toArray(),
        diameter,
        depth,
      },
      `Drill a ${diameter} diameter hole ${depth === null ? 'through' : `${depth} deep into`} F${drillFace.id}, centred on the face.`,
    );
  };

  const downloadSource = async () => {
    if (!activeArtifact) return;
    if (activeArtifact.source.startsWith('storage:')) {
      // An imported file: hand back the original upload.
      const { data: file, error: downloadError } = await supabase.storage
        .from('meshes')
        .download(activeArtifact.source.slice('storage:'.length));
      if (downloadError || !file) {
        setError('Could not download the imported file.');
        return;
      }
      const fileUrl = URL.createObjectURL(file);
      const link = document.createElement('a');
      link.href = fileUrl;
      link.download = activeArtifact.title;
      link.click();
      URL.revokeObjectURL(fileUrl);
      return;
    }
    const extension =
      activeArtifact.sourceFormat === 'cadquery'
        ? 'py'
        : activeArtifact.sourceFormat === 'openscad'
          ? 'scad'
          : 'cadseq.txt';
    const url = URL.createObjectURL(new Blob([activeArtifact.source], { type: 'text/plain' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `opencad-${activeMessage?.id ?? 'model'}.${extension}`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const downloadRendered = (format: 'stl' | 'step') => {
    if (!renderResult) return;
    const binary = atob(format === 'stl' ? renderResult.stlBase64 : renderResult.stepBase64);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `opencad-${activeMessage?.id ?? 'model'}.${format}`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-adam-bg-secondary-dark text-adam-text-primary lg:flex-row">
      <section className="flex min-h-0 w-full flex-col border-r border-adam-neutral-700 lg:w-[42%]">
        <header className="border-b border-adam-neutral-700 p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h1 className="truncate font-semibold">{conversation.title}</h1>
              <p className="text-xs text-adam-text-secondary">CADFusion · CAD-Editor · CAD-Coder</p>
            </div>
            <div className="flex shrink-0 gap-1">
              <button
                type="button"
                aria-label="Undo"
                title={undoRow ? `Undo (back to “${artifactIn(undoRow)?.title ?? 'previous version'}”) · Ctrl/⌘+Z` : 'Nothing to undo'}
                disabled={!undoRow || busy}
                className="rounded-lg border border-adam-neutral-600 p-2 hover:bg-adam-neutral-700 disabled:opacity-40"
                onClick={() => void moveToVersion(undoRow)}
              >
                <Undo2 className="h-4 w-4" />
              </button>
              <button
                type="button"
                aria-label="Redo"
                title={redoRow ? `Redo (forward to “${artifactIn(redoRow)?.title ?? 'next version'}”) · Ctrl/⌘+Shift+Z` : 'Nothing to redo'}
                disabled={!redoRow || busy}
                className="rounded-lg border border-adam-neutral-600 p-2 hover:bg-adam-neutral-700 disabled:opacity-40"
                onClick={() => void moveToVersion(redoRow)}
              >
                <Redo2 className="h-4 w-4" />
              </button>
            </div>
          </div>
          {topology && (
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-adam-text-secondary">
              <span>Longest side</span>
              <input
                className="w-20 rounded bg-adam-neutral-800 px-2 py-1 text-adam-text-primary"
                inputMode="decimal"
                placeholder={
                  mmPerUnit ? String(Number((topology.size * mmPerUnit).toPrecision(4))) : 'mm'
                }
                value={sizeInput}
                onChange={(event) => setSizeInput(event.target.value)}
              />
              <span>mm</span>
              <button type="button" className="underline" onClick={() => void saveRealSize()}>
                Set
              </button>
              {mmPerUnit && <span>· lengths like "5mm" are converted</span>}
            </div>
          )}
        </header>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
          {branch.map((message) => {
            const artifact = artifactIn(message);
            const body = asParametricParts(message.parts)
              .filter((part) => part.type === 'text')
              .map((part) => part.text)
              .join('\n');
            return (
              <div key={message.id} className="rounded-xl bg-adam-neutral-800 p-3 text-sm">
                <div className="mb-1 text-xs font-medium text-adam-text-secondary">
                  {message.role === 'user' ? 'You' : 'OpenCAD'}
                </div>
                {body && <p className="whitespace-pre-wrap">{body}</p>}
                {asParametricParts(message.parts).some((part) => part.type === 'file') && (
                  <p className="mt-1 text-xs">Image attached</p>
                )}
                {artifact && (
                  <button
                    type="button"
                    className="mt-2 rounded-lg border border-adam-neutral-600 px-3 py-2 text-left hover:bg-adam-neutral-700"
                    onClick={() => setSelectedId(message.id)}
                  >
                    View {artifact.title} · {artifact.sourceFormat}
                  </button>
                )}
              </div>
            );
          })}
          {answer && (
            <div
              role="status"
              className="whitespace-pre-wrap rounded-lg border border-adam-blue p-3 text-sm"
            >
              {answer}
            </div>
          )}
          {busy && <p className="text-sm text-adam-text-secondary">Running CAD model…</p>}
          {error && (
            <div role="alert" className="rounded-lg border border-red-500 p-3 text-sm text-red-300">
              {error}
              {branch.at(-1)?.role === 'user' && (
                <button
                  type="button"
                  className="ml-3 underline"
                  onClick={() => {
                    const leaf = branch.at(-1);
                    if (leaf) {
                      attemptedLeaves.current.delete(leaf.id);
                      void generate(leaf.id);
                    }
                  }}
                >
                  Retry
                </button>
              )}
            </div>
          )}
        </div>
        <form
          className="space-y-2 border-t border-adam-neutral-700 p-4"
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          {topology && selection.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              {selection.map((item) => (
                <span
                  key={selectionKey(item)}
                  className="flex items-center gap-1 rounded-full bg-amber-500/20 px-2 py-1 text-xs text-amber-200"
                >
                  {selectionKey(item)} · {item.kind}
                  <button
                    type="button"
                    aria-label={`Deselect ${selectionKey(item)}`}
                    onClick={() =>
                      setSelection((current) =>
                        current.filter(
                          (entry) => selectionKey(entry) !== selectionKey(item),
                        ),
                      )
                    }
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
              <button
                type="button"
                className="text-xs underline"
                onClick={() => setSelection([])}
              >
                Clear
              </button>
              <button
                type="button"
                disabled={busy || deletable.length === 0}
                title="Delete the selected faces or edges (Delete key)"
                className="inline-flex items-center gap-1 rounded-md border border-red-500 px-2 py-0.5 text-xs text-red-300 disabled:opacity-40"
                onClick={() => void deleteSelected()}
              >
                <Trash2 className="h-3 w-3" />
                Delete
              </button>
            </div>
          )}
          {pendingFill && (
            <div className="space-y-2 rounded-lg border border-red-500 p-2 text-xs">
              <p>
                {pendingFill.op.type === 'fill' ? 'The red faces are the cavity that will be filled.' : 'The red faces are what will be deleted.'} Happy with it?
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={busy}
                  className="rounded-md bg-adam-blue px-3 py-1.5 text-white disabled:opacity-50"
                  onClick={() => {
                    const { op, description } = pendingFill;
                    setPendingFill(null);
                    void applyOps([op], description);
                  }}
                >
                  {pendingFill.op.type === 'fill' ? 'Fill it' : 'Delete it'}
                </button>
                <button
                  type="button"
                  className="rounded-md border border-adam-neutral-600 px-3 py-1.5"
                  onClick={() => setPendingFill(null)}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
          {marker && (
            <div className="space-y-2 rounded-lg border border-red-500 p-2 text-xs">
              <p>
                Marker: {describeMarker(marker, mmPerUnit)}. Happy with it? Drill
                here, or ask me to move or redraw it.
              </p>
              {!marker.inside && (
                <p className="text-amber-300">
                  The marker centre is outside the face outline.
                </p>
              )}
              <div className="flex flex-wrap items-center gap-2">
                <label className="flex items-center gap-1">
                  Depth
                  <input
                    className="w-20 rounded bg-adam-neutral-800 px-2 py-1"
                    inputMode="decimal"
                    placeholder="through"
                    value={markerDepth}
                    onChange={(event) => setMarkerDepth(event.target.value)}
                  />
                </label>
                <button
                  type="button"
                  disabled={busy}
                  className="rounded-md bg-adam-blue px-3 py-1.5 text-white disabled:opacity-50"
                  onClick={() =>
                    void drillAtMarker(markerDepth.trim() === '' ? null : Number(markerDepth))
                  }
                >
                  Drill hole here
                </button>
                <button
                  type="button"
                  className="rounded-md border border-adam-neutral-600 px-3 py-1.5"
                  onClick={() => setMarker(null)}
                >
                  Clear marker
                </button>
              </div>
            </div>
          )}
          {drillFace && (
            <div className="space-y-2 rounded-lg border border-adam-neutral-600 p-2 text-xs">
              <p>
                Drill a hole in F{drillFace.id}, centred on the face (model
                units). Typing &ldquo;drill&rdquo; does this too.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <label className="flex items-center gap-1">
                  Diameter
                  <input
                    className="w-20 rounded bg-adam-neutral-800 px-2 py-1"
                    inputMode="decimal"
                    value={holeDiameter || String(defaultDiameter)}
                    onChange={(event) => setHoleDiameter(event.target.value)}
                  />
                </label>
                <label className="flex items-center gap-1">
                  Depth
                  <input
                    className="w-20 rounded bg-adam-neutral-800 px-2 py-1"
                    inputMode="decimal"
                    placeholder="through"
                    value={holeDepth}
                    onChange={(event) => setHoleDepth(event.target.value)}
                  />
                </label>
                <button
                  type="button"
                  disabled={busy}
                  className="rounded-md bg-adam-blue px-3 py-1.5 text-white disabled:opacity-50"
                  onClick={() => void applyHole()}
                >
                  Drill hole
                </button>
              </div>
            </div>
          )}
          {plane && (
            <div className="rounded-lg border border-adam-neutral-600 p-2 text-xs">
              {'error' in plane ? (
                <p className="text-adam-text-secondary">
                  Cut by plane: {plane.error}
                </p>
              ) : (
                <div className="space-y-2">
                  <p>
                    Cut along {plane.label}. Typing &ldquo;cut&rdquo; with this
                    selection splits the part exactly here.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={busy}
                      className="rounded-md bg-adam-blue px-3 py-1.5 text-white disabled:opacity-50"
                      onClick={() => void applyCut('positive')}
                    >
                      Keep {plane.positiveName} side
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      className="rounded-md bg-adam-blue px-3 py-1.5 text-white disabled:opacity-50"
                      onClick={() => void applyCut('negative')}
                    >
                      Keep {plane.negativeName} side
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      className="rounded-md border border-adam-neutral-600 px-3 py-1.5 disabled:opacity-50"
                      onClick={() => void applyCut('split')}
                    >
                      Split apart
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
          <textarea
            className="min-h-20 w-full rounded-lg bg-adam-neutral-800 p-3 text-sm outline-none"
            placeholder={
              selection.length > 0
                ? 'What should change about the selection? e.g. cut along these edges'
                : 'Describe a CAD part or request an edit'
            }
            value={text}
            onChange={(event) => setText(event.target.value)}
            disabled={busy}
          />
          <div className="flex items-center gap-2 text-xs text-adam-text-secondary">
            <label htmlFor="cad-provider">Model</label>
            <select
              id="cad-provider"
              className="rounded-md border border-adam-neutral-600 bg-adam-neutral-800 px-2 py-1 text-adam-text-primary outline-none disabled:opacity-50"
              value={provider}
              disabled={busy}
              onChange={(event) => {
                const next = event.target.value === 'claude-code' ? 'claude-code' : 'cad-plaintext';
                setProvider(next);
                try {
                  localStorage.setItem('cadam.cadProvider', next);
                } catch {
                  // Remembering the choice is a convenience only.
                }
              }}
            >
              <option value="cad-plaintext">cad-plaintext (self-hosted)</option>
              <option value="claude-code">Claude Code (local CLI)</option>
            </select>
          </div>
          <div className="flex items-center gap-3">
            <label
              className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-lg border border-adam-neutral-600 hover:bg-adam-neutral-700"
              title="Attach a screenshot or reference image"
            >
              <ImagePlus className="h-4 w-4" aria-label="Attach image" />
              <input
                className="sr-only"
                type="file"
                accept="image/*"
                onChange={(event) => {
                  setImage(event.target.files?.[0] ?? null);
                  event.target.value = '';
                }}
                disabled={busy}
              />
            </label>
            {image && (
              <div className="flex min-w-0 items-center gap-2">
                <img
                  src={imagePreview ?? undefined}
                  alt="Attached reference"
                  className="h-9 w-9 rounded-md object-cover"
                />
                <span className="truncate text-xs">{image.name}</span>
                <button
                  type="button"
                  className="rounded p-1 hover:bg-adam-neutral-700"
                  aria-label="Remove image"
                  onClick={() => setImage(null)}
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            )}
            <button
              className="ml-auto rounded-lg bg-adam-blue px-4 py-2 text-sm text-white disabled:opacity-50"
              type="submit"
              disabled={busy || (!text.trim() && !image)}
            >
              Send
            </button>
          </div>
        </form>
      </section>
      <section className="flex min-h-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-adam-neutral-700 p-4">
          <div>
            <h2 className="font-medium">{activeArtifact?.title || 'CAD artifact'}</h2>
            {activeArtifact && <p className="text-xs text-adam-text-secondary">{activeArtifact.modelId} · {activeArtifact.sourceFormat}</p>}
          </div>
          {activeArtifact && <div className="flex gap-2">
            <button type="button" className="rounded-lg border px-3 py-2 text-xs" onClick={downloadSource}>Source</button>
            {renderResult && <>
              <button type="button" className="rounded-lg border px-3 py-2 text-xs" onClick={() => downloadRendered('stl')}>STL</button>
              {renderResult.stepBase64 && (
                <button type="button" className="rounded-lg border px-3 py-2 text-xs" onClick={() => downloadRendered('step')}>STEP</button>
              )}
            </>}
          </div>}
        </header>
        {activeArtifact?.sourceFormat === 'openscad' ? (
          <div className="min-h-0 flex-1"><OpenSCADPreview scadCode={activeArtifact.source} color="#00A6FF" /></div>
        ) : activeArtifact ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="min-h-0 flex-1 bg-adam-neutral-700">
              {geometry && topology ? (
                <CadSelectViewer
                  geometry={geometry}
                  topology={topology}
                  selection={selection}
                  plane={plane && !('error' in plane) ? plane : null}
                  marker={marker}
                  highlight={pendingFill?.geometry ?? null}
                  color="#00A6FF"
                  onPick={pick}
                />
              ) : (
                <div className="flex h-full items-center justify-center p-4 text-center text-sm text-adam-text-secondary">
                  {rendering ? 'Rendering 3D preview…' : renderError || 'No preview available'}
                </div>
              )}
            </div>
            <details className="max-h-[35%] overflow-auto border-t border-adam-neutral-700 p-3 text-xs">
              <summary className="cursor-pointer">Native {activeArtifact.sourceFormat} source</summary>
              <pre className="mt-2 whitespace-pre-wrap break-words font-mono">
                {activeArtifact.source.startsWith('storage:')
                  ? `Imported file: ${activeArtifact.title}`
                  : activeArtifact.source}
              </pre>
            </details>
          </div>
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-adam-text-secondary">Send a request to create CAD source</div>
        )}
      </section>
    </div>
  );
}
