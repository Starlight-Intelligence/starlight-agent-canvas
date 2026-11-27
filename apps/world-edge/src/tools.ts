import {
  addNodeInputSchema,
  getRegionInputSchema,
  getWorldInputSchema,
  importWhiteboardInputSchema,
  layoutRegionInputSchema,
  linkInputSchema,
  moveInputSchema,
  proposeCanonInputSchema,
  searchInputSchema,
  updateNodeInputSchema,
  WORLD_TOOL_INPUTS,
} from '@starlight-agent-canvas/world';

/**
 * MCP tool input schemas. The definitions live in `@starlight-agent-canvas/world`
 * (`src/tools.ts`) so this server and the agent client in
 * `@starlight-agent-canvas/world-agents` share one copy. They are built from
 * the L1 op schemas, so a tool can never accept a field an op would reject
 * (canon, version, createdBy, worldId on entities).
 */

export const getWorldInput = getWorldInputSchema;
export const getRegionInput = getRegionInputSchema;
export const searchInput = searchInputSchema;
export const addNodeInput = addNodeInputSchema;
export const updateNodeInput = updateNodeInputSchema;
export const linkInput = linkInputSchema;
export const moveInput = moveInputSchema;
export const proposeCanonInput = proposeCanonInputSchema;
export const layoutRegionInput = layoutRegionInputSchema;
export const importWhiteboardInput = importWhiteboardInputSchema;

export const TOOL_INPUTS = WORLD_TOOL_INPUTS;

export type ToolName = keyof typeof TOOL_INPUTS;
export const TOOL_NAMES = Object.keys(TOOL_INPUTS) as ToolName[];
