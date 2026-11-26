import {
  boundsSchema,
  claudeWhiteboardSchema,
  entityIdSchema,
  LIMITS,
  moveNodesOpSchema,
  NODE_KINDS,
  nodeInputSchema,
  nodeKindSchema,
  nodePatchSchema,
  relationSchema,
  SEMANTIC_ZOOM_LEVELS,
  worldIdSchema,
} from '@starlight-agent-canvas/world';
import { z } from 'zod';
import { LAYOUT_STRATEGIES } from './layout.js';
import { REGION_LIMITS } from './region.js';

/**
 * MCP tool input schemas. Built from the L1 zod schemas so a tool can never
 * accept a field an op would reject (canon, version, createdBy, worldId on
 * entities). Kept separate from the server so tests can check them directly.
 */

const worldId = { worldId: worldIdSchema.describe('World id, e.g. "arcanea".') };

export const getWorldInput = z.strictObject({ ...worldId });

export const getRegionInput = z.strictObject({
  ...worldId,
  regionId: entityIdSchema.optional().describe('Authored region id. Use this or bounds.'),
  bounds: boundsSchema.optional().describe('World-space rectangle {x, y, w, h}.'),
  level: z.enum(SEMANTIC_ZOOM_LEVELS).optional().describe('cluster (counts only), card (titles), or full (body and media).'),
  zoom: z.number().finite().positive().optional().describe('Viewport zoom; mapped to a level when level is not set.'),
  kinds: z.array(nodeKindSchema).max(NODE_KINDS.length).optional(),
  limit: z.number().int().positive().max(REGION_LIMITS.maxNodes).optional(),
}).refine((q) => Boolean(q.regionId || q.bounds), { message: 'Pass regionId or bounds.' });

export const searchInput = z.strictObject({
  ...worldId,
  query: z.string().min(1).max(500),
  kinds: z.array(nodeKindSchema).max(NODE_KINDS.length).optional(),
  limit: z.number().int().positive().max(50).optional(),
});

/** Same as an addNode op's node, except the id may be omitted; the server fills it. */
export const addNodeInput = z.strictObject({
  ...worldId,
  node: nodeInputSchema.extend({ id: entityIdSchema.optional() }),
});

export const updateNodeInput = z.strictObject({
  ...worldId,
  id: entityIdSchema,
  baseVersion: z.number().int().positive().describe('The node version you last read.'),
  patch: nodePatchSchema,
});

export const linkInput = z.strictObject({
  ...worldId,
  from: entityIdSchema,
  to: entityIdSchema,
  relation: relationSchema,
  label: z.string().min(1).max(LIMITS.labelMax).optional(),
});

export const moveInput = z.strictObject({
  ...worldId,
  moves: moveNodesOpSchema.shape.moves,
});

export const proposeCanonInput = z.strictObject({
  ...worldId,
  title: z.string().min(1).max(LIMITS.titleMax).describe('Short title for the canon PR.'),
  targets: z.array(z.strictObject({
    type: z.enum(['node', 'edge']),
    id: entityIdSchema,
    baseVersion: z.number().int().positive(),
  })).min(1).max(100),
  rationale: z.string().min(1).max(LIMITS.summaryMax).describe('Why this belongs in canon. Goes into the PR body.'),
});

export const layoutRegionInput = z.strictObject({
  ...worldId,
  regionId: entityIdSchema,
  strategy: z.enum(LAYOUT_STRATEGIES),
});

export const importWhiteboardInput = z.strictObject({
  ...worldId,
  whiteboard: claudeWhiteboardSchema,
  lexicon: z.strictObject({
    kinds: z.record(z.string(), nodeKindSchema).optional(),
    tags: z.record(z.string(), z.array(z.string().min(1).max(LIMITS.tagMax))).optional(),
  }).optional(),
  title: z.string().min(1).max(LIMITS.titleMax).optional(),
  dryRun: z.boolean().optional().describe('Return the import report without writing.'),
});

export const TOOL_INPUTS = {
  get_world: getWorldInput,
  get_region: getRegionInput,
  search: searchInput,
  add_node: addNodeInput,
  update_node: updateNodeInput,
  link: linkInput,
  move: moveInput,
  propose_canon: proposeCanonInput,
  layout_region: layoutRegionInput,
  import_whiteboard: importWhiteboardInput,
} as const;

export type ToolName = keyof typeof TOOL_INPUTS;
export const TOOL_NAMES = Object.keys(TOOL_INPUTS) as ToolName[];
