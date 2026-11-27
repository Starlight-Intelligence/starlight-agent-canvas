import { z } from 'zod';
import { claudeWhiteboardSchema } from './import/claude-whiteboard.js';
import { moveNodesOpSchema, nodeInputSchema, nodePatchSchema } from './ops.js';
import {
  boundsSchema,
  entityIdSchema,
  LIMITS,
  NODE_KINDS,
  nodeKindSchema,
  relationSchema,
  worldIdSchema,
} from './schemas.js';
import { SEMANTIC_ZOOM_LEVELS } from './zoom.js';

/**
 * Input schemas for the ten World Canvas MCP tools (spec section 8). One
 * definition shared by the server (apps/world-edge) and the agent client
 * (packages/world-agents), so the two cannot drift apart.
 *
 * Built from the op schemas, so a tool can never accept a field an op would
 * reject (canon, version, createdBy, worldId on entities). Every input is a
 * strict object and takes `worldId`.
 */

/** Server-side limits that shape tool inputs. */
export const WORLD_TOOL_LIMITS = {
  /** Most nodes one get_region call may return. */
  regionMaxNodes: 5_000,
  searchQueryMax: 500,
  searchMaxLimit: 50,
  proposalTargetsMax: 100,
} as const;

export const LAYOUT_STRATEGIES = ['grid', 'layered', 'force'] as const;
export type LayoutStrategy = (typeof LAYOUT_STRATEGIES)[number];

const worldId = { worldId: worldIdSchema.describe('World id, e.g. "arcanea".') };

export const getWorldInputSchema = z.strictObject({ ...worldId });

export const getRegionInputSchema = z.strictObject({
  ...worldId,
  regionId: entityIdSchema.optional().describe('Authored region id. Use this or bounds.'),
  bounds: boundsSchema.optional().describe('World-space rectangle {x, y, w, h}.'),
  level: z.enum(SEMANTIC_ZOOM_LEVELS).optional().describe('cluster (counts only), card (titles), or full (body and media). Wins over zoom.'),
  zoom: z.number().finite().positive().optional().describe('Viewport zoom; mapped to a level when level is not set.'),
  kinds: z.array(nodeKindSchema).max(NODE_KINDS.length).optional(),
  limit: z.number().int().positive().max(WORLD_TOOL_LIMITS.regionMaxNodes).optional(),
}).refine((q) => Boolean(q.regionId || q.bounds), { message: 'Pass regionId or bounds.' });

export const searchInputSchema = z.strictObject({
  ...worldId,
  query: z.string().min(1).max(WORLD_TOOL_LIMITS.searchQueryMax),
  kinds: z.array(nodeKindSchema).max(NODE_KINDS.length).optional(),
  limit: z.number().int().positive().max(WORLD_TOOL_LIMITS.searchMaxLimit).optional(),
});

/**
 * An addNode op's node with the id optional (the server fills it) and no
 * `canon`: nodes added through MCP are drafts. Proposing goes through
 * propose_canon, which records the proposal row the canon PR flow reads
 * (spec 3.5). An add_node with `canon: proposed` would skip that row.
 */
export const addNodeNodeInputSchema = nodeInputSchema.omit({ canon: true }).extend({ id: entityIdSchema.optional() });

export const addNodeInputSchema = z.strictObject({
  ...worldId,
  node: addNodeNodeInputSchema,
});

export const updateNodeInputSchema = z.strictObject({
  ...worldId,
  id: entityIdSchema,
  baseVersion: z.number().int().positive().describe('The node version you last read.'),
  patch: nodePatchSchema,
});

export const linkInputSchema = z.strictObject({
  ...worldId,
  from: entityIdSchema,
  to: entityIdSchema,
  relation: relationSchema,
  label: z.string().min(1).max(LIMITS.labelMax).optional(),
}).refine((input) => input.from !== input.to, { message: 'Edges cannot connect a node to itself.', path: ['to'] });

export const moveInputSchema = z.strictObject({
  ...worldId,
  moves: moveNodesOpSchema.shape.moves,
});

export const proposeCanonTargetSchema = z.strictObject({
  type: z.enum(['node', 'edge']),
  id: entityIdSchema,
  baseVersion: z.number().int().positive(),
});

/** No `ref` and no status: the server sets `proposed` and records a proposal row. It opens no PR. */
export const proposeCanonInputSchema = z.strictObject({
  ...worldId,
  title: z.string().min(1).max(LIMITS.titleMax).describe('Short title for the canon PR.'),
  targets: z.array(proposeCanonTargetSchema).min(1).max(WORLD_TOOL_LIMITS.proposalTargetsMax),
  rationale: z.string().min(1).max(LIMITS.summaryMax).describe('Why this belongs in canon. Goes into the PR body.'),
});

export const layoutRegionInputSchema = z.strictObject({
  ...worldId,
  regionId: entityIdSchema,
  strategy: z.enum(LAYOUT_STRATEGIES),
});

export const importLexiconInputSchema = z.strictObject({
  /** Exact title (case-insensitive) to node kind. */
  kinds: z.record(z.string(), nodeKindSchema).optional(),
  /** Exact title (case-insensitive) to extra tags. */
  tags: z.record(z.string(), z.array(z.string().min(1).max(LIMITS.tagMax))).optional(),
});

/** Seeds an empty world; the server refuses a world that already has content. */
export const importWhiteboardInputSchema = z.strictObject({
  ...worldId,
  whiteboard: claudeWhiteboardSchema,
  lexicon: importLexiconInputSchema.optional(),
  title: z.string().min(1).max(LIMITS.titleMax).optional(),
  dryRun: z.boolean().optional().describe('Return the import report without writing.'),
});

export const WORLD_TOOL_INPUTS = {
  get_world: getWorldInputSchema,
  get_region: getRegionInputSchema,
  search: searchInputSchema,
  add_node: addNodeInputSchema,
  update_node: updateNodeInputSchema,
  link: linkInputSchema,
  move: moveInputSchema,
  propose_canon: proposeCanonInputSchema,
  layout_region: layoutRegionInputSchema,
  import_whiteboard: importWhiteboardInputSchema,
} as const;

export type WorldToolInputName = keyof typeof WORLD_TOOL_INPUTS;
