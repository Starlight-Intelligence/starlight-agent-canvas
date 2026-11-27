import { z } from 'zod';
import {
  actorSchema,
  addNodeInputSchema,
  addNodeNodeInputSchema,
  boundsSchema,
  entityIdSchema,
  getRegionInputSchema,
  getWorldInputSchema,
  importLexiconInputSchema,
  importWhiteboardInputSchema,
  LAYOUT_STRATEGIES,
  layoutRegionInputSchema,
  LIMITS,
  linkInputSchema,
  mediaSchema,
  moveInputSchema,
  positionSchema,
  proposeCanonInputSchema,
  proposeCanonTargetSchema,
  regionSchema,
  searchInputSchema,
  SEMANTIC_ZOOM_LEVELS,
  updateNodeInputSchema,
  WORLD_TOOL_LIMITS,
  worldEdgeSchema,
  worldNodeSchema,
  worldSchema,
} from '@starlight-agent-canvas/world';

/** Input schemas come from L1 (`packages/world/src/tools.ts`), shared with the server. */
export {
  addNodeInputSchema,
  addNodeNodeInputSchema,
  getRegionInputSchema,
  getWorldInputSchema,
  importWhiteboardInputSchema,
  LAYOUT_STRATEGIES,
  layoutRegionInputSchema,
  linkInputSchema,
  moveInputSchema,
  proposeCanonInputSchema,
  proposeCanonTargetSchema,
  searchInputSchema,
  updateNodeInputSchema,
};

/**
 * Client-side contract for the World Canvas MCP tools. Inputs are L1's shared
 * schemas (packages/world/src/tools.ts), the same ones the L2 server
 * registers. Outputs match apps/world-edge src/mcp.ts and src/world-agent.ts.
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

/** Server-side limits that shape tool inputs (shared with apps/world-edge through L1). */
export const WORLD_EDGE_LIMITS = WORLD_TOOL_LIMITS;

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

export const addNodeOutputSchema = writeResultSchema;

// update_node

export const updateNodeOutputSchema = writeResultSchema;

// link

export const linkOutputSchema = writeResultSchema;

// move

export const moveOutputSchema = writeResultSchema;

// propose_canon

export const proposeCanonOutputSchema = writeResultSchema.extend({
  proposalId: z.string().min(1),
});

// layout_region

export const layoutRegionOutputSchema = writeResultSchema.extend({
  /** Number of nodes moved. */
  moved: countSchema,
});

// import_whiteboard

export const importLexiconSchema = importLexiconInputSchema;

/**
 * L1's ImportReport (packages/world/src/import/claude-whiteboard.ts), field
 * for field. Unknown keys are stripped so additive server fields do not break
 * the client; a missing or mistyped field fails the call.
 */
export const importReportSchema = z.object({
  source: z.object({ title: z.string(), format: z.string().optional(), exportedAt: z.string().optional() }),
  elementsIn: countSchema,
  elementsByType: countMapSchema,
  nodesOut: countSchema,
  nodesByKind: countMapSchema,
  edgesOut: countSchema,
  edgesByRelation: countMapSchema,
  regionsOut: countSchema,
  dispositions: z.object({
    node: countSchema,
    merged: countSchema,
    expanded: countSchema,
    edge: countSchema,
    region: countSchema,
    skipped: countSchema,
  }),
  needsReupload: countSchema,
  skipped: z.array(z.object({ elementId: z.string(), reason: z.string() })),
  truncated: z.array(z.object({
    nodeId: z.string(),
    elementIds: z.array(z.string()),
    field: z.enum(['title', 'summary', 'body', 'regionTitle']),
    originalLength: countSchema,
    keptLength: countSchema,
    fullTextIn: z.literal('body').nullable(),
  })),
  warnings: z.array(z.string()),
});

/** A write: the world version and ops_log seq it produced. Never marked dryRun. */
export const importWhiteboardWriteOutputSchema = z.object({
  ok: z.literal(true),
  dryRun: z.literal(false).optional(),
  version: versionSchema,
  seq: z.number().int().nonnegative(),
  report: importReportSchema,
});

/** A dry run: the report only, nothing written, so no version or seq. */
export const importWhiteboardDryRunOutputSchema = z.strictObject({
  ok: z.literal(true),
  dryRun: z.literal(true),
  report: importReportSchema,
});

/**
 * Either mode. The client additionally checks that the mode matches the
 * request (see createWorldClient), so a write is never reported for a dry run
 * or the other way round.
 */
export const importWhiteboardOutputSchema = z.union([importWhiteboardDryRunOutputSchema, importWhiteboardWriteOutputSchema]);

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
