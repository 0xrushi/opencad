import { tool, type InferUITools, type UIMessage } from 'ai';
import { z } from 'zod';
import type { MeshFileType, Model } from './types.ts';

export const createMeshInputSchema = z.object({
  text: z.string().optional(),
  imageIds: z.array(z.string()).optional(),
  meshId: z.string().optional(),
  model: z.enum(['fast', 'quality', 'ultra']).optional(),
  meshTopology: z.enum(['quads', 'polys']).optional(),
  polygonCount: z.number().optional(),
});

export const createMeshOutputSchema = z.object({
  id: z.string(),
  fileType: z.enum(['glb', 'stl', 'obj', 'fbx']),
});

export const parametricArtifactSchema = z.object({
  title: z.string().min(1),
  version: z.string().default('v1'),
  code: z.string().min(20),
});

export const parametricCompileOutputSchema = z.object({
  status: z.literal('success'),
  message: z.string(),
  inspection: z
    .object({
      views: z.array(
        z.enum(['ISO', 'FRONT', 'BACK', 'LEFT', 'RIGHT', 'TOP', 'BOTTOM']),
      ),
      imageAttached: z.boolean(),
    })
    .optional(),
});

export const answerUserSchema = z.object({
  message: z.string().min(1),
});

export const chatTools = {
  build_parametric_model: tool({
    description:
      'Create or update the complete OpenSCAD CAD artifact. After the browser compiles it, inspect the returned multi-view preview sheet and call this tool again if the model needs another revision.',
    inputSchema: parametricArtifactSchema,
    outputSchema: parametricCompileOutputSchema,
  }),
  answer_user: tool({
    description:
      'Send the final user-facing chat message. Use this for normal non-CAD replies, and after a CAD build when the multi-view preview satisfies the user request.',
    inputSchema: answerUserSchema,
    outputSchema: answerUserSchema,
  }),
  create_mesh: tool({
    description:
      'Create a 3D mesh from text, images, or an existing mesh plus edit instructions.',
    inputSchema: createMeshInputSchema,
    outputSchema: createMeshOutputSchema,
  }),
};

export type AppTools = InferUITools<typeof chatTools>;

export type MeshContextData = {
  meshId: string;
  fileType: MeshFileType;
  filename?: string;
  boundingBox?: { x: number; y: number; z: number };
};

export type MeshPreferencesData = {
  topology: 'quads' | 'polys';
  polygonCount: number;
};

/**
 * Conversation-level signals the server emits as transient stream parts
 * (`writer.write({ transient: true, type: 'data-X', data })`). Transient
 * parts never land in `messages.parts` — they're side-channel updates the
 * client folds straight into the conversation query cache.
 *
 *  * `title-update`    fires once when the server generates a title for
 *    a fresh conversation; client updates `conversations.title`.
 *  * `suggestions-update` fires after each assistant turn finishes;
 *    client updates `conversations.settings.suggestions` so the pills
 *    below the input refresh in lock-step with the response.
 */
export type ConversationTitleUpdate = {
  conversationId: string;
  title: string;
};
export type ConversationSuggestionsUpdate = {
  conversationId: string;
  suggestions: string[];
};

/** A plane split applied after the model's geometry, in the shape's own units. */
export type CadCut = {
  origin: [number, number, number];
  normal: [number, number, number];
  /** Which side of the plane survives; `split` keeps both, moved apart. */
  keep: 'positive' | 'negative' | 'split';
};

/** A round hole drilled into a planar face, against that face's outward normal. */
export type CadHole = {
  origin: [number, number, number];
  normal: [number, number, number];
  diameter: number;
  /** Null drills all the way through. */
  depth: number | null;
  /** Counterbore or countersink; the default is a plain round hole. */
  style?: 'simple' | 'counterbore' | 'countersink';
  head_diameter?: number;
  /** Counterbore depth. */
  head_depth?: number;
  /** Countersink opening angle in degrees (90 by default). */
  angle?: number;
};

type Vec3 = [number, number, number];

/** A 2D outline sketched on a planar face, used by pockets, bosses and text. */
export type CadProfile = {
  origin: Vec3;
  normal: Vec3;
  profile: 'circle' | 'rect' | 'slot';
  diameter?: number;
  /** Rectangle width, or the overall length of a slot. */
  width?: number;
  /** Rectangle height, or the width of a slot. */
  height?: number;
  /** Degrees about the face normal. */
  rotation?: number;
};

/** Operations that repeat. */
export type CadRepeatable =
  | ({ type: 'hole' } & CadHole)
  | ({ type: 'pocket' } & CadProfile & { depth?: number | null })
  | ({ type: 'boss' } & CadProfile & { depth: number })
  | { type: 'text'; origin: Vec3; normal: Vec3; text: string; size?: number; distance: number; rotation?: number };

/**
 * Exact geometry operations applied, in order, after the model's output. Each
 * is expressed in the frame of the shape produced by the operations before it,
 * because that is the geometry the user was looking at when selecting.
 */
export type CadOp =
  | ({ type: 'cut' } & CadCut)
  | ({ type: 'hole' } & CadHole)
  /** Edges are identified by a point on each, matched to the nearest B-rep edge. */
  | { type: 'fillet'; points: [number, number, number][]; radius: number }
  | { type: 'chamfer'; points: [number, number, number][]; distance: number }
  /** Moves the side of `origin` along `normal` away by `distance` (negative shrinks). */
  | {
      type: 'stretch';
      origin: [number, number, number];
      normal: [number, number, number];
      distance: number;
    }
  /** Fills the holes whose walls contain these points (one on each selected face or edge). */
  | { type: 'fill'; points: [number, number, number][] }
  /** Removes a boss, fillet, chamfer or similar feature at these points. */
  | { type: 'remove'; points: Vec3[] }
  /** Deletes the selected faces or edges: fills a cavity, removes a boss or a blend, as the geometry calls for. */
  | { type: 'delete'; points: Vec3[] }
  | ({ type: 'pocket' } & CadProfile & { depth?: number | null })
  | ({ type: 'boss' } & CadProfile & { depth: number })
  /** Positive `distance` raises the text, negative engraves it. */
  | { type: 'text'; origin: Vec3; normal: Vec3; text: string; size?: number; distance: number; rotation?: number }
  /** Hollows the part; `points` pick the faces to leave open. */
  | { type: 'shell'; thickness: number; points: Vec3[] }
  /** Moves a planar face along its normal (positive outward). */
  | { type: 'offset_face'; points: Vec3[]; distance: number }
  /** A gusset in the corner edge through `origin` along `vector`, between faces with outward normals `normal` and `normal2`. */
  | { type: 'rib'; origin: Vec3; vector: Vec3; normal: Vec3; normal2: Vec3; thickness: number; size: number }
  | { type: 'draft'; origin: Vec3; normal: Vec3; angle: number; points: Vec3[] }
  /** Boolean with another saved version of this conversation, resolved by the server when rendering. */
  | { type: 'combine'; mode: 'union' | 'subtract' | 'intersect'; versionId: string }
  | ({ type: 'pattern'; of: CadRepeatable; count: number } & (
      | { kind: 'linear'; vector: Vec3; distance: number }
      | { kind: 'circular'; origin: Vec3; normal: Vec3; angle?: number }
    ))
  | { type: 'scale'; factor: number; origin: [number, number, number] }
  | { type: 'translate'; vector: [number, number, number] }
  | {
      type: 'mirror';
      origin: [number, number, number];
      normal: [number, number, number];
    };

export type AppDataTypes = {
  'cad-artifact': {
    sourceFormat: 'cad-sequence' | 'cadquery' | 'step' | 'stl';
    /** For `step`/`stl`: `storage:<path in the meshes bucket>` of the uploaded file. */
    source: string;
    modelId: string;
    title: string;
    version: string;
    ops?: CadOp[];
    /** Legacy: cut-only history from before `ops`. */
    cuts?: CadCut[];
  };
  'cad-op': CadOp;
  /** An uploaded STEP/STL file in the `meshes` bucket, used as the first version. */
  'cad-import': { path: string; filename: string; format: 'step' | 'stl' };
  'mesh-context': MeshContextData;
  'mesh-preferences': MeshPreferencesData;
  'title-update': ConversationTitleUpdate;
  'suggestions-update': ConversationSuggestionsUpdate;
};

export const meshContextDataSchema = z.object({
  meshId: z.string(),
  fileType: z.enum(['glb', 'stl', 'obj', 'fbx']),
  filename: z.string().optional(),
  boundingBox: z
    .object({ x: z.number(), y: z.number(), z: z.number() })
    .optional(),
});

export const meshPreferencesDataSchema = z.object({
  topology: z.enum(['quads', 'polys']),
  polygonCount: z.number(),
});

export type AppUIMessage = UIMessage<
  {
    model?: Model;
    billingTokens?: number;
    // The model's original OpenSCAD for this message's artifact, captured
    // lazily on the FIRST parameter edit (see `persistParameterEdit`).
    // Parameter edits rewrite the live `tool-build_parametric_model` input
    // code in place, which would otherwise move the derived `defaultValue`
    // to the edited value on every reload. Stashing the original here —
    // message metadata is UI-only and NOT sent to the model by
    // `convertToModelMessages` — lets the client re-derive stable defaults
    // (Reset / slider home / auto range) with no second code copy in the
    // model's context, no migration, and no storage cost on the (common)
    // never-edited artifacts.
    originalCode?: string;
  },
  AppDataTypes,
  AppTools
>;
