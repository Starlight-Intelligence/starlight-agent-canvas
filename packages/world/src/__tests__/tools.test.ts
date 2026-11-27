import { describe, expect, it } from 'vitest';
import { WORLD_TOOL_INPUTS } from '../tools.js';

describe('shared MCP tool input schemas', () => {
  it('names the ten spec section 8 tools', () => {
    expect(Object.keys(WORLD_TOOL_INPUTS).sort()).toEqual(
      ['add_node', 'get_region', 'get_world', 'import_whiteboard', 'layout_region', 'link', 'move', 'propose_canon', 'search', 'update_node'],
    );
  });

  it('add_node accepts drafts only', () => {
    const base = { worldId: 'w', node: { kind: 'character', title: 'A', position: { x: 0, y: 0 } } };
    expect(WORLD_TOOL_INPUTS.add_node.safeParse(base).success).toBe(true);
    expect(WORLD_TOOL_INPUTS.add_node.safeParse({ ...base, node: { ...base.node, canon: { status: 'draft' } } }).success).toBe(false);
    expect(WORLD_TOOL_INPUTS.add_node.safeParse({ ...base, node: { ...base.node, canon: { status: 'proposed' } } }).success).toBe(false);
  });

  it('link rejects a self-link and unknown keys', () => {
    expect(WORLD_TOOL_INPUTS.link.safeParse({ worldId: 'w', from: 'a', to: 'b', relation: 'rules' }).success).toBe(true);
    expect(WORLD_TOOL_INPUTS.link.safeParse({ worldId: 'w', from: 'a', to: 'a', relation: 'rules' }).success).toBe(false);
    expect(WORLD_TOOL_INPUTS.link.safeParse({ worldId: 'w', from: 'a', to: 'b', relation: 'rules', canon: { status: 'canon' } }).success).toBe(false);
  });

  it('get_region needs regionId or bounds', () => {
    expect(WORLD_TOOL_INPUTS.get_region.safeParse({ worldId: 'w' }).success).toBe(false);
    expect(WORLD_TOOL_INPUTS.get_region.safeParse({ worldId: 'w', regionId: 'r' }).success).toBe(true);
  });
});
