import { z } from 'zod';
import {
  actorSchema,
  addEdgeOpSchema,
  boundsSchema,
  claudeWhiteboardSchema,
  entityIdSchema,
  LIMITS,
  moveNodesOpSchema,
  nodeInputSchema,
  nodeKindSchema,
  nodePatchSchema,
  positionSchema,
  proposeCanonOpSchema,
  relationSchema,
  SEMANTIC_ZOOM_LEVELS,
  updateNodeOpSchema,
  worldEdgeSchema,
  worldIdSchema,
  worldNodeSchema,
  worldSchema,
} from '@starlight-agent-canvas/world';

/**
 * Client-side contract for the World Canvas MCP tools (spec section 8).
 *
 * Input schemas are strict: unknown keys are rejected so a typo, or an
 * attempt to smuggle `canon`, `version` or `createdBy`, fails locally before
 * anything is sent. Output schemas are plain objects: unknown keys are
 * stripped, so additive server fields do not break the client.
 *
 * There is deliberately no tool for removeNode, removeEdge or promoteToCanon.
 */

const worldVersionSchema = z.number().int().nonnegative();
const countSchema = z.number().int().nonnegative();

export const semanticZoomLevelSchema = z.enum(SEMANTIC_ZOOM_LEVELS);

/**
 * L1's CanonProposal is a TypeScript interface only. This schema mirrors it
 * field for field. It is used for tool output, never for input.
 */
export const canonProposalSchema = z.object({
  targetType: z.enum(['node', 'edge']),
  id: entityIdSchema,
  title: z.string().min(1),
  version: z.number().int().positive(),
  ref: z.url().optional(),
  note: z.string().max(LIMITS.summaryMax).optional(),
  proposedBy: actorSchema,
});

// get_world

export const getWorldInputSchema = z.strictObject({
  worldId: worldIdSchema,
});

export const getWorldOutputSchema = z.object({
  world: worldSchema,
  counts: z.object({
    nodes: z.partialRecord(nodeKindSchema, countSchema),
    edges: z.partialRecord(relationSchema, countSchema),
  }),
  worldVersion: worldVersionSchema,
});

// get_region

export const getRegionInputSchema = z.strictObject({
  worldId: worldIdSchema,
  regionId: entityIdSchema.optional(),
  bounds: boundsSchema.optional(),
  level: semanticZoomLevelSchema.optional(),
}).refine((input) => (input.regionId === undefined) !== (input.bounds === undefined), {
  message: 'Pass exactly one of regionId or bounds.',
  path: ['regionId'],
});

export const getRegionOutputSchema = z.object({
  level: semanticZoomLevelSchema,
  nodes: z.array(worldNodeSchema),
  edges: z.array(worldEdgeSchema),
  clusters: z.array(z.object({
    tileKey: z.string().regex(/^-?\d+:-?\d+$/, 'tileKey must look like "<x>:<y>".'),
    counts: z.partialRecord(nodeKindSchema, countSchema),
  })).optional(),
  worldVersion: worldVersionSchema,
});

// search

export const searchInputSchema = z.strictObject({
  worldId: worldIdSchema,
  query: z.string().min(1).max(500),
  kinds: z.array(nodeKindSchema).min(1).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

export const searchResultSchema = z.object({
  id: entityIdSchema,
  kind: nodeKindSchema,
  title: z.string().min(1).max(LIMITS.titleMax),
  summary: z.string().max(LIMITS.summaryMax),
  position: positionSchema,
  regionId: entityIdSchema.nullable(),
  score: z.number().finite().optional(),
});

export const searchOutputSchema = z.object({
  results: z.array(searchResultSchema),
  worldVersion: worldVersionSchema,
});

// add_node

/** L1's node input with `id` optional: the server fills it (spec 4.1). */
export const addNodeNodeInputSchema = nodeInputSchema.extend({
  id: entityIdSchema.optional(),
});

export const addNodeInputSchema = z.strictObject({
  worldId: worldIdSchema,
  node: addNodeNodeInputSchema,
});

export const addNodeOutputSchema = z.object({
  node: worldNodeSchema,
  worldVersion: worldVersionSchema,
});

// update_node

export const updateNodeInputSchema = z.strictObject({
  worldId: worldIdSchema,
  id: updateNodeOpSchema.shape.id,
  baseVersion: updateNodeOpSchema.shape.baseVersion,
  patch: nodePatchSchema,
});

export const updateNodeOutputSchema = z.object({
  node: worldNodeSchema,
  worldVersion: worldVersionSchema,
});

// link

export const linkInputSchema = addEdgeOpSchema.shape.edge
  .pick({ from: true, to: true, relation: true, label: true })
  .extend({ worldId: worldIdSchema })
  .refine((input) => input.from !== input.to, { message: 'Edges cannot connect a node to itself.', path: ['to'] });

export const linkOutputSchema = z.object({
  edge: worldEdgeSchema,
  worldVersion: worldVersionSchema,
});

// move

export const moveInputSchema = z.strictObject({
  worldId: worldIdSchema,
  moves: moveNodesOpSchema.shape.moves,
});

export const moveOutputSchema = z.object({
  nodes: z.array(worldNodeSchema),
  worldVersion: worldVersionSchema,
});

// propose_canon

/** No `ref` and no status: the server sets `proposed` and later writes the PR URL itself. */
export const proposeCanonInputSchema = z.strictObject({
  worldId: worldIdSchema,
  target: proposeCanonOpSchema.shape.target,
  baseVersion: proposeCanonOpSchema.shape.baseVersion,
  note: z.string().min(1).max(LIMITS.summaryMax),
});

export const proposeCanonOutputSchema = z.object({
  proposal: canonProposalSchema,
  prUrl: z.url({ protocol: /^https$/ }).optional(),
  worldVersion: worldVersionSchema,
});

// layout_region

export const LAYOUT_STRATEGIES = ['grid', 'layered', 'force'] as const;

export const layoutRegionInputSchema = z.strictObject({
  worldId: worldIdSchema,
  regionId: entityIdSchema,
  strategy: z.enum(LAYOUT_STRATEGIES),
});

export const layoutRegionOutputSchema = z.object({
  moved: z.array(worldNodeSchema),
  worldVersion: worldVersionSchema,
});

// import_whiteboard

export const importWhiteboardInputSchema = z.strictObject({
  /** Omit to create a new world; pass an existing world id to import into a draft branch. */
  worldId: worldIdSchema.optional(),
  whiteboard: claudeWhiteboardSchema,
  lexicon: z.looseObject({}).optional(),
});

export const importWhiteboardOutputSchema = z.object({
  report: z.looseObject({}),
  worldId: worldIdSchema,
  worldVersion: worldVersionSchema.optional(),
  branch: z.string().min(1).optional(),
});

/** Every tool the client offers, by MCP tool name. */
export const WORLD_TOOLS = {
  get_world: { input: getWorldInputSchema, output: getWorldOutputSchema },
  get_region: { input: getRegionInputSchema, output: getRegionOutputSchema },
  search: { input: searchInputSchema, output: searchOutputSchema },
  add_node: { input: addNodeInputSchema, output: addNodeOutputSchema },
  update_node: { input: updateNodeInputSchema, output: updateNodeOutputSchema },
  link: { input: linkInputSchema, output: linkOutputSchema },
  move: { input: moveInputSchema, output: moveOutputSchema },
  propose_canon: { input: proposeCanonInputSchema, output: proposeCanonOutputSchema },
  layout_region: { input: layoutRegionInputSchema, output: layoutRegionOutputSchema },
  import_whiteboard: { input: importWhiteboardInputSchema, output: importWhiteboardOutputSchema },
} as const;

export type WorldToolName = keyof typeof WORLD_TOOLS;
export const WORLD_TOOL_NAMES = Object.keys(WORLD_TOOLS) as WorldToolName[];

/** What a caller passes (before defaults). */
export type WorldToolInput<N extends WorldToolName> = z.input<(typeof WORLD_TOOLS)[N]['input']>;
/** What the client returns (after parsing). */
export type WorldToolOutput<N extends WorldToolName> = z.output<(typeof WORLD_TOOLS)[N]['output']>;
