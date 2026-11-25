import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { TOOL_INPUTS, TOOL_NAMES } from '../src/tools.js';
import { bearer, testEnv, worldName } from './helpers.js';

describe('MCP tool schemas', () => {
  it('exposes exactly the spec tools', () => {
    expect(TOOL_NAMES.sort()).toEqual(['add_node', 'get_region', 'get_world', 'import_whiteboard', 'layout_region', 'link', 'move', 'propose_canon', 'search', 'update_node'].sort());
  });

  it('add_node accepts a node without id and rejects canon, version and createdBy', () => {
    const base = { worldId: 'arcanea', node: { kind: 'character', title: 'Arion', position: { x: 0, y: 0 } } };
    expect(TOOL_INPUTS.add_node.safeParse(base).success).toBe(true);
    expect(TOOL_INPUTS.add_node.safeParse({ ...base, node: { ...base.node, canon: { status: 'proposed' } } }).success).toBe(true);
    expect(TOOL_INPUTS.add_node.safeParse({ ...base, node: { ...base.node, canon: { status: 'canon', ref: 'https://x.y/z' } } }).success).toBe(false);
    expect(TOOL_INPUTS.add_node.safeParse({ ...base, node: { ...base.node, version: 9 } }).success).toBe(false);
    expect(TOOL_INPUTS.add_node.safeParse({ ...base, node: { ...base.node, createdBy: { harness: 'human', at: '2026-01-01T00:00:00Z' } } }).success).toBe(false);
    expect(TOOL_INPUTS.add_node.safeParse({ ...base, worldId: '../etc' }).success).toBe(false);
    expect(TOOL_INPUTS.add_node.safeParse({ ...base, node: { ...base.node, kind: 'dragon' } }).success).toBe(false);
  });

  it('update_node requires baseVersion and a non-empty patch without canon', () => {
    const base = { worldId: 'arcanea', id: 'n_a', baseVersion: 1, patch: { title: 'x' } };
    expect(TOOL_INPUTS.update_node.safeParse(base).success).toBe(true);
    expect(TOOL_INPUTS.update_node.safeParse({ ...base, baseVersion: undefined }).success).toBe(false);
    expect(TOOL_INPUTS.update_node.safeParse({ ...base, patch: {} }).success).toBe(false);
    expect(TOOL_INPUTS.update_node.safeParse({ ...base, patch: { canon: { status: 'canon' } } }).success).toBe(false);
  });

  it('get_region needs regionId or bounds; link needs a known relation; layout needs a known strategy', () => {
    expect(TOOL_INPUTS.get_region.safeParse({ worldId: 'a' }).success).toBe(false);
    expect(TOOL_INPUTS.get_region.safeParse({ worldId: 'a', bounds: { x: 0, y: 0, w: 0, h: 1 } }).success).toBe(false);
    expect(TOOL_INPUTS.get_region.safeParse({ worldId: 'a', bounds: { x: 0, y: 0, w: 10, h: 10 }, level: 'card' }).success).toBe(true);
    expect(TOOL_INPUTS.link.safeParse({ worldId: 'a', from: 'n_a', to: 'n_b', relation: 'loves' }).success).toBe(false);
    expect(TOOL_INPUTS.layout_region.safeParse({ worldId: 'a', regionId: 'r', strategy: 'circle' }).success).toBe(false);
    expect(TOOL_INPUTS.propose_canon.safeParse({ worldId: 'a', title: 't', targets: [], rationale: 'r' }).success).toBe(false);
  });
});

async function rpc(token: string, method: string, params: Record<string, unknown> = {}) {
  const response = await SELF.fetch('https://world-edge.test/mcp', {
    method: 'POST',
    headers: {
      ...bearer(token),
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-06-18',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const text = await response.text();
  const dataLine = text.split('\n').find((line) => line.startsWith('data:'));
  const body = JSON.parse(dataLine ? dataLine.slice(5) : text) as { result?: { tools?: { name: string }[]; content?: { text: string }[]; isError?: boolean }; error?: unknown };
  return { status: response.status, body };
}

function toolJson(body: Awaited<ReturnType<typeof rpc>>['body']) {
  return JSON.parse(body.result?.content?.[0]?.text ?? 'null') as Record<string, unknown>;
}

describe('MCP over HTTP', () => {
  it('lists the tools for an authenticated service token', async () => {
    const { status, body } = await rpc(testEnv.TEST_TOKENS.claude, 'tools/list');
    expect(status).toBe(200);
    expect(body.result?.tools?.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
  });

  it('writes through the WorldAgent and records the calling harness', async () => {
    const worldId = worldName('mcp');
    const added = await rpc(testEnv.TEST_TOKENS.codex, 'tools/call', {
      name: 'add_node',
      arguments: { worldId, node: { kind: 'place', title: 'Aetheria Gate', position: { x: 10, y: 20 } } },
    });
    expect(added.body.result?.isError).toBeFalsy();
    const created = toolJson(added.body) as { ok: boolean; version: number; nodes: { id: string; createdBy: { harness: string } }[] };
    expect(created.ok).toBe(true);
    expect(created.version).toBe(1);
    expect(created.nodes[0]!.id).toMatch(/^n_aetheria-gate_/);
    expect(created.nodes[0]!.createdBy.harness).toBe('codex');

    const stale = await rpc(testEnv.TEST_TOKENS.claude, 'tools/call', {
      name: 'update_node',
      arguments: { worldId, id: created.nodes[0]!.id, baseVersion: 7, patch: { title: 'x' } },
    });
    expect(stale.body.result?.isError).toBe(true);
    expect(toolJson(stale.body)).toMatchObject({ ok: false, error: { code: 'STALE_VERSION', expectedVersion: 7, actualVersion: 1 } });

    const search = await rpc(testEnv.TEST_TOKENS.claude, 'tools/call', { name: 'search', arguments: { worldId, query: 'Aetheria' } });
    const found = toolJson(search.body) as { mode: string; hits: { id: string }[] };
    // No Vectorize or AI in tests: search degrades to a text match.
    expect(['d1-like', 'do-like']).toContain(found.mode);
  });

  it('rejects invalid tool input before it reaches the world', async () => {
    const worldId = worldName('mcp');
    const bad = await rpc(testEnv.TEST_TOKENS.claude, 'tools/call', {
      name: 'add_node',
      arguments: { worldId, node: { kind: 'place', title: 'X', position: { x: 0, y: 0 }, canon: { status: 'canon', ref: 'https://a.b/c' } } },
    });
    const failed = Boolean(bad.body.error) || bad.body.result?.isError === true;
    expect(failed).toBe(true);
    const world = await rpc(testEnv.TEST_TOKENS.claude, 'tools/call', { name: 'get_world', arguments: { worldId } });
    expect(toolJson(world.body)).toMatchObject({ counts: { nodes: 0 } });
  });
});
