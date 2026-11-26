import { z } from 'zod';
import {
  actorSchema,
  addEdgeOpSchema,
  boundsSchema,
  claudeWhiteboardSchema,
  entityIdSchema,
  LIMITS,
  mediaSchema,
  moveNodesOpSchema,
  NODE_KINDS,
  nodeInputSchema,
  nodeKindSchema,
  nodePatchSchema,
  positionSchema,
  proposeCanonOpSchema,
  regionSchema,
  SEMANTIC_ZOOM_LEVELS,
  updateNodeOpSchema,
  worldEdgeSchema,
  worldIdSchema,
  worldNodeSchema,
  worldSchema,
} from '@starlight-agent-canvas/world';

/**
 * Client-side contract for the World Canvas MCP tools, matching the L2 server
 * (apps/world-edge: src/tools.ts for inputs, src/mcp.ts and
 * src/world-agent.ts for results).
 *
 * Input schemas are strict: unknown keys are rejected so a typo, or an
 * attempt to smuggle `canon`, `version` or `createdBy`, fails locally before
 * anything is sent. Output schemas are plain objects: unknown keys are
 * stripped, so additive server fields do not break the client. Where the
 * server types a value as a plain string (search hit kinds, count keys), so
 * does the client.
 *
 * There is deliberately no tool for removeNode, removeEdge or promoteToCanon.
 */

/** Server-side limits from apps/world-edge that shape tool inputs. */
export const WORLD_EDGE_LIMITS = {
  /** REGION_LIMITS.maxNodes in apps/world-edge/src/region.ts. */
  regionMaxNodes: 5_000,
  searchMaxLimit: 50,
  proposalTargetsMax: 100,
} as const;

const versionSchema = z.number().int().nonnegative();
const countSchema = z.number().int().nonnegative();
const countMapSchema = z.record(z.string(), countSchema);

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

/**
 * Success shape of every L2 write (WriteResult with ok: true). Failures
 * arrive as tool errors and become WorldToolError in the transport.
 */
export const writeResultSchema = z.object({
  ok: z.literal(true),
  /** World version after the write. */
  version: versionSchema,
  /** ops_log sequence number of the batch (0 when nothing was written). */
  seq: z.number().int().nonnegative(),
  nodes: z.array(worldNodeSchema),
  edges: z.array(worldEdgeSchema),
  removedNodes: z.array(z.string()),
  removedEdges: z.array(z.string()),
  proposals: z.array(canonProposalSchema),
});

// get_world

export const getWorldInputSchema = z.strictObject({
  worldId: worldIdSchema,
});

export const getWorldOutputSchema = z.object({
  world: worldSchema,
  counts: z.object({
    nodes: countSchema,
    edges: countSchema,
    nodesByKind: countMapSchema,
    edgesByRelation: countMapSchema,
  }),
  openProposals: countSchema,
});

// get_region

export const getRegionInputSchema = z.strictObject({
  worldId: worldIdSchema,
  regionId: entityIdSchema.optional(),
  bounds: boundsSchema.optional(),
  /** Wins over zoom when both are set. */
  level: semanticZoomLevelSchema.optional(),
  /** Viewport zoom factor; the server maps it to a level when level is not set. */
  zoom: z.number().finite().positive().optional(),
  kinds: z.array(nodeKindSchema).max(NODE_KINDS.length).optional(),
  limit: z.number().int().positive().max(WORLD_EDGE_LIMITS.regionMaxNodes).optional(),
}).refine((input) => input.regionId !== undefined || input.bounds !== undefined, {
  message: 'Pass regionId or bounds.',
});

/** L2's NodeCard: what a card shows. No body, no full media list. */
export const nodeCardSchema = z.object({
  id: worldNodeSchema.shape.id,
  kind: worldNodeSchema.shape.kind,
  title: worldNodeSchema.shape.title,
  tags: worldNodeSchema.shape.tags,
  position: worldNodeSchema.shape.position,
  size: worldNodeSchema.shape.size,
  regionId: worldNodeSchema.shape.regionId,
  layer: worldNodeSchema.shape.layer,
  canon: worldNodeSchema.shape.canon,
  version: worldNodeSchema.shape.version,
  thumbnail: mediaSchema.optional(),
});

/** L2's EdgeSummary: Pick<WorldEdge, id | from | to | relation | label | canon | version>. */
export const edgeSummarySchema = z.object({
  id: worldEdgeSchema.shape.id,
  from: worldEdgeSchema.shape.from,
  to: worldEdgeSchema.shape.to,
  relation: worldEdgeSchema.shape.relation,
  label: worldEdgeSchema.shape.label,
  canon: worldEdgeSchema.shape.canon,
  version: worldEdgeSchema.shape.version,
});

/** L2's ClusterSummary: per-tile counts for the cluster level. */
export const clusterSummarySchema = z.object({
  tile: z.string(),
  count: countSchema,
  byKind: countMapSchema,
  /** Mean node position in the tile. */
  center: positionSchema,
});

const regionResultBase = {
  ok: z.literal(true),
  version: versionSchema,
  bounds: boundsSchema,
  regions: z.array(regionSchema),
  clusters: z.array(clusterSummarySchema),
  truncated: z.boolean(),
};

/**
 * L2 returns full nodes and edges at `full`, cards and edge summaries at
 * `card`, and only clusters at `cluster`. The level tells the client which.
 */
export const getRegionOutputSchema = z.discriminatedUnion('level', [
  z.object({ ...regionResultBase, level: z.literal('cluster'), nodes: z.array(nodeCardSchema).max(0), edges: z.array(edgeSummarySchema).max(0) }),
  z.object({ ...regionResultBase, level: z.literal('card'), nodes: z.array(nodeCardSchema), edges: z.array(edgeSummarySchema) }),
  z.object({ ...regionResultBase, level: z.literal('full'), nodes: z.array(worldNodeSchema), edges: z.array(worldEdgeSchema) }),
]);

// search

export const searchInputSchema = z.strictObject({
  worldId: worldIdSchema,
  query: z.string().min(1).max(500),
  kinds: z.array(nodeKindSchema).max(NODE_KINDS.length).optional(),
  limit: z.number().int().positive().max(WORLD_EDGE_LIMITS.searchMaxLimit).optional(),
});

export const SEARCH_MODES = ['semantic', 'd1-like', 'do-like'] as const;

/** L2's SearchHit. The server types id, kind and title as plain strings. */
export const searchHitSchema = z.object({
  id: z.string(),
  kind: z.string(),
  title: z.string(),
  summary: z.string(),
  position: positionSchema,
  regionId: z.string().nullable(),
  score: z.number().optional(),
});

export const searchOutputSchema = z.object({
  mode: z.enum(SEARCH_MODES),
  hits: z.array(searchHitSchema),
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

export const addNodeOutputSchema = writeResultSchema;

// update_node

export const updateNodeInputSchema = z.strictObject({
  worldId: worldIdSchema,
  id: updateNodeOpSchema.shape.id,
  baseVersion: updateNodeOpSchema.shape.baseVersion,
  patch: nodePatchSchema,
});

export const updateNodeOutputSchema = writeResultSchema;

// link

/** The server has no self-link check in its schema; applyOps rejects it. The client rejects it locally. */
export const linkInputSchema = addEdgeOpSchema.shape.edge
  .pick({ from: true, to: true, relation: true, label: true })
  .extend({ worldId: worldIdSchema })
  .refine((input) => input.from !== input.to, { message: 'Edges cannot connect a node to itself.', path: ['to'] });

export const linkOutputSchema = writeResultSchema;

// move

export const moveInputSchema = z.strictObject({
  worldId: worldIdSchema,
  moves: moveNodesOpSchema.shape.moves,
});

export const moveOutputSchema = writeResultSchema;

// propose_canon

/** One target: L1's proposeCanon target plus the version the caller last read. */
export const proposeCanonTargetSchema = proposeCanonOpSchema.shape.target.extend({
  baseVersion: proposeCanonOpSchema.shape.baseVersion,
});

/** No `ref` and no status: the server sets `proposed` and records a proposal row. It opens no PR. */
export const proposeCanonInputSchema = z.strictObject({
  worldId: worldIdSchema,
  title: z.string().min(1).max(LIMITS.titleMax),
  targets: z.array(proposeCanonTargetSchema).min(1).max(WORLD_EDGE_LIMITS.proposalTargetsMax),
  rationale: z.string().min(1).max(LIMITS.summaryMax),
});

export const proposeCanonOutputSchema = writeResultSchema.extend({
  proposalId: z.string().min(1),
});

// layout_region

export const LAYOUT_STRATEGIES = ['grid', 'layered', 'force'] as const;

export const layoutRegionInputSchema = z.strictObject({
  worldId: worldIdSchema,
  regionId: entityIdSchema,
  strategy: z.enum(LAYOUT_STRATEGIES),
});

export const layoutRegionOutputSchema = writeResultSchema.extend({
  /** Number of nodes moved. */
  moved: countSchema,
});

// import_whiteboard

/** L2's lexicon: L1's ImportLexicon with tag strings bounded like node tags. */
export const importLexiconSchema = z.strictObject({
  /** Exact title (case-insensitive) to node kind. */
  kinds: z.record(z.string(), nodeKindSchema).optional(),
  /** Exact title (case-insensitive) to extra tags. */
  tags: z.record(z.string(), z.array(z.string().min(1).max(LIMITS.tagMax))).optional(),
});

/** Seeds an empty world; the server refuses a world that already has content. */
export const importWhiteboardInputSchema = z.strictObject({
  worldId: worldIdSchema,
  whiteboard: claudeWhiteboardSchema,
  lexicon: importLexiconSchema.optional(),
  title: z.string().min(1).max(LIMITS.titleMax).optional(),
  /** Return the import report without writing. */
  dryRun: z.boolean().optional(),
});

/** L1's ImportReport, kept loose: the client passes it through. */
const importReportSchema = z.looseObject({});

export const importWhiteboardOutputSchema = z.union([
  z.object({ ok: z.literal(true), version: versionSchema, seq: z.number().int().nonnegative(), report: importReportSchema }),
  z.object({ ok: z.literal(true), dryRun: z.literal(true), report: importReportSchema }),
]);

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
