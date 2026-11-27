import { describe, expect, it } from 'vitest';
import { queryTiles, tileCountFor } from '../src/region.js';
import { agentFor, claude, nodeOp, worldName } from './helpers.js';

describe('get_region', () => {
  async function seeded() {
    const agent = await agentFor(worldName('region'));
    const ops: unknown[] = [];
    // A 10 x 10 grid spaced 1000 units apart: 0..9000 on both axes.
    for (let i = 0; i < 10; i++) {
      for (let j = 0; j < 10; j++) ops.push(nodeOp(`n_${i}_${j}`, i * 1000, j * 1000, { body: 'long body', summary: 's', kind: i < 5 ? 'character' : 'place' }));
    }
    ops.push(nodeOp('n_far', 1_000_000, 1_000_000));
    ops.push({ op: 'addEdge', edge: { from: 'n_0_0', to: 'n_far', relation: 'references' } });
    const result = await agent.applyBatch(ops, claude);
    expect(result.ok).toBe(true);
    return agent;
  }

  it('returns only nodes whose box overlaps the bounds', async () => {
    const agent = await seeded();
    const result = await agent.getRegion({ bounds: { x: 1500, y: 1500, w: 2000, h: 1000 }, level: 'full' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.nodes.map((n) => n.id).sort();
    // x in {2000, 3000}, y in {2000}: boxes are 1x1 at the node position.
    expect(ids).toEqual(['n_2_2', 'n_3_2']);
    expect(result.truncated).toBe(false);
  });

  it('includes edges that leave the bounds but never the far node itself', async () => {
    const agent = await seeded();
    const result = await agent.getRegion({ bounds: { x: -10, y: -10, w: 20, h: 20 }, level: 'card' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.nodes.map((n) => n.id)).toEqual(['n_0_0']);
    expect(result.edges.map((e) => e.to)).toEqual(['n_far']);
    // card level carries no body.
    expect(result.nodes[0]).not.toHaveProperty('body');
    expect(result.nodes[0]).not.toHaveProperty('summary');
  });

  it('cluster level returns tile counts by kind and no nodes', async () => {
    const agent = await seeded();
    const result = await agent.getRegion({ bounds: { x: 0, y: 0, w: 9999, h: 9999 }, zoom: 0.1 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.level).toBe('cluster');
    expect(result.nodes).toEqual([]);
    const total = result.clusters.reduce((sum, c) => sum + c.count, 0);
    expect(total).toBe(100);
    const kinds = result.clusters.reduce<Record<string, number>>((acc, c) => {
      for (const [k, n] of Object.entries(c.byKind)) acc[k] = (acc[k] ?? 0) + n;
      return acc;
    }, {});
    expect(kinds).toEqual({ character: 50, place: 50 });
  });

  it('honors limit and reports truncation', async () => {
    const agent = await seeded();
    const result = await agent.getRegion({ bounds: { x: 0, y: 0, w: 9999, h: 9999 }, level: 'card', limit: 7 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.nodes).toHaveLength(7);
      expect(result.truncated).toBe(true);
    }
  });

  it('finds a node wider than a tile whose origin is several tiles away', async () => {
    const agent = await agentFor(worldName('wide'));
    await agent.applyBatch([nodeOp('n_wide', 0, 0, { size: { w: 6000, h: 100 } }), nodeOp('n_small', 5050, 50)], claude);
    const result = await agent.getRegion({ bounds: { x: 5000, y: 0, w: 100, h: 100 }, level: 'card' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.nodes.map((n) => n.id).sort()).toEqual(['n_small', 'n_wide']);
    const outside = await agent.getRegion({ bounds: { x: 6100, y: 0, w: 100, h: 100 }, level: 'card' });
    if (outside.ok) expect(outside.nodes).toEqual([]);
  });

  it('reports edge truncation separately from node truncation', async () => {
    const agent = await seeded();
    const result = await agent.getRegion({ bounds: { x: 0, y: 0, w: 9999, h: 9999 }, level: 'card', limit: 7 });
    expect(result.ok && [result.truncated, result.nodesTruncated, result.edgesTruncated]).toEqual([true, true, false]);
  });

  it('refuses bounds that would read too many tiles', async () => {
    const agent = await seeded();
    const result = await agent.getRegion({ bounds: { x: 0, y: 0, w: 2048 * 64, h: 2048 * 64 }, level: 'card' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('BOUNDS_TOO_LARGE');
  });

  it('rejects a query with neither regionId nor bounds', async () => {
    const agent = await seeded();
    const result = await agent.getRegion({ level: 'card' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringMatching(/regionId or bounds/) });
  });

  it('pads tiles up and left so nodes starting outside the viewport are found', () => {
    expect(queryTiles({ x: 0, y: 0, w: 10, h: 10 })).toEqual(['-1:-1', '0:-1', '-1:0', '0:0']);
    expect(tileCountFor({ x: 0, y: 0, w: 10, h: 10 })).toBe(4);
  });
});
