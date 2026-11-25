import { WORLD_GRAPH_SCHEMA_VERSION, type WorldNode } from '@starlight-agent-canvas/world';
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env.js';
import { semanticSearch, syncIndex } from '../src/indexing.js';
import { LAYOUT_STRATEGIES, layoutNodes } from '../src/layout.js';
import type { WriteResult } from '../src/world-agent.js';
import { agentFor, claude, nodeOp, testEnv, worldName } from './helpers.js';

function node(id: string, version = 1, title = id): WorldNode {
  return {
    id, worldId: 'w', kind: 'character', title, summary: '', body: '', tags: [], canon: { status: 'draft' }, media: [],
    position: { x: 0, y: 0 }, regionId: null, layer: 0,
    createdBy: { harness: 'claude', at: '2026-11-25T00:00:00.000Z' }, updatedAt: '2026-11-25T00:00:00.000Z', version, meta: {},
  };
}

describe('layout stays inside the region', () => {
  const bounds = { x: 100, y: 200, w: 400, h: 400 };
  const nodes = Array.from({ length: 10 }, (_, i) => node(`n_${i}`));
  const chain = nodes.slice(1).map((n, i) => ({ ...node('e'), id: `e_${i}`, from: nodes[i]!.id, to: n.id, relation: 'precedes' as const })) as never[];

  for (const strategy of LAYOUT_STRATEGIES) {
    it(`${strategy} keeps all 10 nodes inside a 400 x 400 region`, () => {
      const moves = layoutNodes(nodes, chain, bounds, strategy);
      expect(moves.length).toBe(10);
      for (const m of moves) {
        expect(m.position.x).toBeGreaterThanOrEqual(bounds.x);
        expect(m.position.x).toBeLessThanOrEqual(bounds.x + bounds.w);
        expect(m.position.y).toBeGreaterThanOrEqual(bounds.y);
        expect(m.position.y).toBeLessThanOrEqual(bounds.y + bounds.h);
      }
      expect(new Set(moves.map((m) => `${m.position.x},${m.position.y}`)).size).toBe(10);
    });
  }

  it('get_region(regionId) still returns every node after layout_region', async () => {
    const worldId = worldName('layout');
    const agent = await agentFor(worldId);
    const graph = {
      schemaVersion: WORLD_GRAPH_SCHEMA_VERSION,
      world: { id: worldId, title: 'Layout', summary: '', version: 0, regions: [{ id: 'r_small', title: 'Small', bounds }], updatedAt: '2026-11-25T00:00:00.000Z' },
      nodes: nodes.map((n) => ({ ...n, worldId, regionId: 'r_small', position: { x: 150, y: 250 } })),
      edges: [],
    };
    expect((await agent.importGraph(graph, claude)).ok).toBe(true);
    const laid = await agent.layoutRegion('r_small', 'layered', claude);
    expect(laid.ok).toBe(true);
    const region = await agent.getRegion({ regionId: 'r_small', level: 'card' });
    expect(region.ok && region.nodes.length).toBe(10);
  });
});

describe('cluster counts honor kinds', () => {
  it('counts only the requested kinds at cluster zoom', async () => {
    const agent = await agentFor(worldName('kinds'));
    await agent.applyBatch([
      nodeOp('n_c1', 10, 10), nodeOp('n_c2', 20, 20),
      nodeOp('n_p1', 30, 30, { kind: 'place' }),
    ], claude);
    const result = await agent.getRegion({ bounds: { x: 0, y: 0, w: 100, h: 100 }, level: 'cluster', kinds: ['character'] });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.clusters.reduce((s, c) => s + c.count, 0)).toBe(2);
      expect(result.clusters.every((c) => !('place' in c.byKind))).toBe(true);
    }
  });
});

describe('index sync ordering', () => {
  it('an older sync arriving late does not overwrite a newer row', async () => {
    const worldId = worldName('idx');
    const world = (version: number) => ({ id: worldId, title: 'Idx', summary: '', version, updatedAt: '2026-11-25T00:00:00.000Z' });
    await syncIndex(testEnv, world(2), 1, [node('n_a', 2, 'Newer title')], []);
    await syncIndex(testEnv, world(1), 1, [node('n_a', 1, 'Older title')], []);
    const row = await testEnv.WORLD_INDEX!.prepare('SELECT title, version FROM world_nodes WHERE world_id = ? AND node_id = ?').bind(worldId, 'n_a').first();
    expect(row).toEqual({ title: 'Newer title', version: 2 });
    const w = await testEnv.WORLD_INDEX!.prepare('SELECT version FROM worlds WHERE id = ?').bind(worldId).first();
    expect(w).toEqual({ version: 2 });
  });
});

describe('semantic search filters kinds inside Vectorize', () => {
  it('passes a kind filter to the vector query', async () => {
    const calls: unknown[] = [];
    const env = {
      AI: { run: async () => ({ data: [[0.1, 0.2]] }) },
      WORLD_VECTORS: {
        query: async (_v: number[], options: unknown) => {
          calls.push(options);
          return { matches: [{ id: 'x', score: 0.9, metadata: { nodeId: 'n_char' } }] };
        },
      },
    } as unknown as Env;
    const hits = await semanticSearch(env, 'arcanea', 'hero', 2, ['character']);
    expect(hits).toEqual([{ nodeId: 'n_char', score: 0.9 }]);
    expect(calls[0]).toMatchObject({ namespace: 'arcanea', filter: { kind: { $in: ['character'] } } });
    await semanticSearch(env, 'arcanea', 'hero', 2);
    expect(calls[1]).not.toHaveProperty('filter');
  });
});

describe('removeNode loads every incident edge', () => {
  it('removes a hub with many edges and leaves no dangling edges', async () => {
    const agent = await agentFor(worldName('hub'));
    const ops: unknown[] = [nodeOp('n_hub')];
    for (let i = 0; i < 400; i++) ops.push(nodeOp(`n_s${i}`, i, 0));
    expect((await agent.applyBatch(ops, claude)).ok).toBe(true);
    const edges: unknown[] = [];
    for (let i = 0; i < 400; i++) edges.push({ op: 'addEdge', edge: { from: 'n_hub', to: `n_s${i}`, relation: 'references' } });
    expect((await agent.applyBatch(edges, claude)).ok).toBe(true);
    const removed = (await agent.applyBatch([{ op: 'removeNode', id: 'n_hub', baseVersion: 1 }], claude)) as WriteResult;
    expect(removed.ok && removed.removedEdges.length).toBe(400);
    expect((await agent.getWorldInfo()).counts.edges).toBe(0);
  });
});
