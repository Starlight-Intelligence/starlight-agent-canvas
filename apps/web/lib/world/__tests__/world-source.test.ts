import { describe, expect, it, vi } from 'vitest';
import { TILE_SIZE, tileKey, tileKeysForBounds, validateWorldGraph } from '@starlight-agent-canvas/world';
import type { WorldGraph } from '@starlight-agent-canvas/world';
import { generateWorld } from '../generate-world';
import { LocalWorldSource } from '../local-source';
import { TileIndex } from '../tile-index';
import { nearestInDirection, neighborhoodLayout, timelineOrder } from '../layouts';
import { describeOps } from '../source';
import { regionTint } from '../tints';

const graphOf = (n: number) => generateWorld({ nodes: n }) as unknown as WorldGraph;

describe('generateWorld', () => {
  it('produces a valid World Graph v1 document at 10k nodes', () => {
    const g = generateWorld({ nodes: 10_000 });
    const result = validateWorldGraph(g);
    expect(result.ok).toBe(true);
    expect(g.nodes).toHaveLength(10_000);
    expect(g.edges.length).toBeGreaterThan(10_000);
    expect(g.world.regions.length).toBe(20);
  });

  it('is deterministic', () => {
    expect(JSON.stringify(generateWorld({ nodes: 300, seed: 7 }))).toBe(JSON.stringify(generateWorld({ nodes: 300, seed: 7 })));
  });
});

describe('TileIndex', () => {
  it('puts every node in exactly one tile', () => {
    const g = graphOf(3000);
    const index = new TileIndex(g);
    const total = [...index.tiles.values()].reduce((s, ids) => s + ids.length, 0);
    expect(total).toBe(3000);
    for (const [key, ids] of index.tiles) for (const id of ids) expect(tileKey(index.nodesById.get(id)!.position)).toBe(key);
  });

  it('limits neighborhoods by depth', () => {
    const g = graphOf(2000);
    const index = new TileIndex(g);
    const one = index.neighborhood('n_gen_10', 1);
    const two = index.neighborhood('n_gen_10', 2);
    expect(one.nodes.length).toBeGreaterThan(1);
    expect(two.nodes.length).toBeGreaterThanOrEqual(one.nodes.length);
    for (const e of two.edges) {
      expect(two.nodes.some((n) => n.id === e.from)).toBe(true);
      expect(two.nodes.some((n) => n.id === e.to)).toBe(true);
    }
  });
});

describe('LocalWorldSource', () => {
  it('returns only nodes in the requested tiles, with touching edges', async () => {
    const source = new LocalWorldSource(graphOf(10_000));
    const keys = tileKeysForBounds({ x: 0, y: 0, w: TILE_SIZE, h: TILE_SIZE });
    const batch = await source.getTiles(keys);
    expect(batch.nodes.length).toBeGreaterThan(0);
    expect(batch.nodes.length).toBeLessThan(1000);
    for (const n of batch.nodes) expect(keys).toContain(tileKey(n.position));
    const ids = new Set(batch.nodes.map((n) => n.id));
    for (const e of batch.edges) expect(ids.has(e.from) || ids.has(e.to)).toBe(true);
  });

  it('cluster counts add up to the node count', async () => {
    const source = new LocalWorldSource(graphOf(4000));
    const clusters = await source.getClusters();
    expect(clusters.reduce((s, c) => s + c.total, 0)).toBe(4000);
  });

  it('applies an update optimistically and bumps versions', async () => {
    const source = new LocalWorldSource(graphOf(50));
    const events: string[] = [];
    source.subscribe((e) => events.push(e.type));
    const out = await source.applyOps([{ op: 'updateNode', id: 'n_gen_1', baseVersion: 1, patch: { title: 'Arion' } }]);
    expect(out.ok).toBe(true);
    const node = await source.getNode('n_gen_1');
    expect(node?.title).toBe('Arion');
    expect(node?.version).toBe(2);
    expect(node?.createdBy.harness).toBe('claude'); // createdBy is kept on update
    expect(events).toContain('changed');
    expect(source.activity()[0].harness).toBe('human');
  });

  it('rejects a stale baseVersion without changing the graph', async () => {
    const source = new LocalWorldSource(graphOf(50));
    const before = source.snapshot();
    const out = await source.applyOps([{ op: 'updateNode', id: 'n_gen_1', baseVersion: 9, patch: { title: 'x' } }]);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe('STALE_VERSION');
    expect(source.snapshot()).toBe(before);
  });

  it('propose canon sets proposed, never canon', async () => {
    const source = new LocalWorldSource(graphOf(50));
    const node = (await source.getNode('n_gen_2'))!;
    const out = await source.applyOps([{ op: 'proposeCanon', target: { type: 'node', id: node.id }, baseVersion: node.version }]);
    expect(out.ok).toBe(true);
    expect((await source.getNode(node.id))?.canon.status).toBe('proposed');
    const forged = await source.applyOps([{ op: 'addNode', node: { id: 'n_x', kind: 'note', title: 'x', position: { x: 0, y: 0 }, canon: { status: 'canon' } } }]);
    expect(forged.ok).toBe(false);
  });

  it('rolls back when the server refuses the batch', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: false, error: { code: 'STALE_VERSION', message: 'stale' } }), { status: 409 }));
    const source = new LocalWorldSource(graphOf(50), { persistUrl: '/api/worlds/stress/ops', fetchImpl: fetchImpl as unknown as typeof fetch });
    const events: string[] = [];
    source.subscribe((e) => events.push(e.type));
    const out = await source.applyOps([{ op: 'updateNode', id: 'n_gen_3', baseVersion: 1, patch: { title: 'Lost edit' } }]);
    expect(out.ok).toBe(false);
    expect((await source.getNode('n_gen_3'))?.version).toBe(1);
    expect(events).toContain('rollback');
    expect(source.activity()[0].status).toBe('rejected');
  });

  it('seeds activity from createdBy harnesses', () => {
    const source = new LocalWorldSource(graphOf(100));
    const harnesses = source.activity().map((a) => a.harness).sort();
    expect(harnesses).toEqual(['chatgpt', 'claude', 'codex', 'human', 'importer']);
  });

  it('searches titles, prefix matches first', async () => {
    const source = new LocalWorldSource(graphOf(500));
    const first = (await source.getNode('n_gen_0'))!;
    const hits = await source.search(first.title.slice(0, 4));
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].title.toLowerCase().startsWith(first.title.slice(0, 4).toLowerCase())).toBe(true);
  });
});

describe('layouts', () => {
  it('orders the timeline by precedes, then position', () => {
    const g = graphOf(10);
    const [a, b, c] = g.nodes;
    const edges = [{ ...g.edges[0], from: c.id, to: a.id, relation: 'precedes' as const }];
    const order = timelineOrder([a, b, c], edges).map((n) => n.id);
    expect(order.indexOf(c.id)).toBeLessThan(order.indexOf(a.id));
  });

  it('puts the focused node at the center of the neighborhood layout', () => {
    const g = graphOf(200);
    const index = new TileIndex(g);
    const hood = index.neighborhood('n_gen_5', 2);
    const pos = neighborhoodLayout('n_gen_5', hood.nodes, hood.edges);
    expect(pos.find((p) => p.id === 'n_gen_5')).toEqual({ id: 'n_gen_5', x: 0, y: 0 });
  });

  it('finds the nearest node in a direction for keyboard navigation', () => {
    const pts = [
      { id: 'right', x: 100, y: 5 },
      { id: 'far-right', x: 400, y: 0 },
      { id: 'up', x: 0, y: -100 },
      { id: 'diag', x: 60, y: 90 },
    ];
    expect(nearestInDirection({ x: 0, y: 0 }, pts, 'right')).toBe('right');
    expect(nearestInDirection({ x: 0, y: 0 }, pts, 'up')).toBe('up');
    expect(nearestInDirection({ x: 0, y: 0 }, pts, 'down')).toBe('diag');
    expect(nearestInDirection({ x: 0, y: 0 }, pts, 'left')).toBeNull();
  });
});

describe('describeOps and tints', () => {
  it('summarizes batches in sentence case', () => {
    const d = describeOps([{ op: 'proposeCanon', target: { type: 'node', id: 'a' }, baseVersion: 1 }], () => 'Arion');
    expect(d.summary).toBe('Proposed Arion for canon');
  });

  it('never uses the gold accent as a region tint', () => {
    expect(regionTint('#ffd700', 0)).not.toBe('#ffd700');
    expect(regionTint('#e7b844', 0)).not.toBe('#e7b844');
    expect(regionTint('#00bcd4', 0)).toBe('#5f8f8a');
    expect(regionTint('#6f9a8d', 0)).toBe('#6f9a8d');
    expect(regionTint(undefined, 3)).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe('RemoteWorldSource', () => {
  it('announces a change after a confirmed batch without waiting for the live feed', async () => {
    const { RemoteWorldSource } = await import('../remote-source');
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      version: 4,
      changed: { nodes: ['n1'], edges: [], removedNodes: [], removedEdges: [] },
      proposals: [],
    }), { status: 200 }));
    const source = new RemoteWorldSource('https://worker.example', 'demo', fetchImpl as unknown as typeof fetch);
    const events: { type: string; version?: number }[] = [];
    source.subscribe((e) => events.push(e as { type: string; version?: number }));
    const out = await source.applyOps([{ op: 'updateNode', id: 'n1', baseVersion: 3, patch: { title: 'x' } }]);
    expect(out.ok).toBe(true);
    expect(events.find((e) => e.type === 'changed')?.version).toBe(4);
    expect(source.activity()[0].status).toBe('confirmed');
  });
});

describe('review fixes', () => {
  it('orders a 100k-node timeline quickly', async () => {
    const { timelineLayout, timelineNodes } = await import('../layouts');
    const g = graphOf(100_000);
    const nodes = timelineNodes(g.nodes, g.edges);
    const t0 = performance.now();
    const out = timelineLayout(nodes, g.edges);
    expect(out).toHaveLength(nodes.length);
    expect(performance.now() - t0).toBeLessThan(3000);
  });

  it('keeps an Unplaced cluster bounded by its own nodes for regionless worlds', async () => {
    const g = graphOf(200);
    const regionless = { ...g, world: { ...g.world, regions: [] }, nodes: g.nodes.map((n) => ({ ...n, regionId: null })) } as WorldGraph;
    const clusters = await new LocalWorldSource(regionless).getClusters();
    expect(clusters).toHaveLength(1);
    expect(clusters[0].regionId).toBeNull();
    expect(clusters[0].total).toBe(200);
    for (const n of regionless.nodes) {
      expect(n.position.x).toBeGreaterThanOrEqual(clusters[0].bounds.x);
      expect(n.position.y).toBeGreaterThanOrEqual(clusters[0].bounds.y);
    }
  });

  it('reloads the authoritative graph after the server rejects a batch', async () => {
    const server = graphOf(50);
    const newer = { ...server, nodes: server.nodes.map((n) => (n.id === 'n_gen_3' ? { ...n, title: 'Saved in another tab', version: 2 } : n)) };
    const fetchImpl = vi.fn(async (url: string) =>
      url.endsWith('/ops')
        ? new Response(JSON.stringify({ ok: false, error: { code: 'STALE_VERSION', message: 'stale' } }), { status: 409 })
        : new Response(JSON.stringify(newer), { status: 200 }),
    );
    const source = new LocalWorldSource(server, { persistUrl: '/api/worlds/stress/ops', reloadUrl: '/api/worlds/stress', fetchImpl: fetchImpl as unknown as typeof fetch });
    const out = await source.applyOps([{ op: 'updateNode', id: 'n_gen_3', baseVersion: 1, patch: { title: 'Mine' } }]);
    expect(out.ok).toBe(false);
    const node = await source.getNode('n_gen_3');
    expect(node?.title).toBe('Saved in another tab');
    expect(node?.version).toBe(2);
  });

  it('remote getNode loads the area around a search hit on a cache miss', async () => {
    const { RemoteWorldSource } = await import('../remote-source');
    const g = graphOf(20);
    const target = g.nodes[7];
    const fetchImpl = vi.fn(async (url: string) =>
      url.endsWith('/search')
        ? new Response(JSON.stringify([{ id: target.id, kind: target.kind, title: target.title, summary: '', position: target.position, regionId: target.regionId }]))
        : new Response(JSON.stringify({ nodes: [target], edges: [] })),
    );
    const source = new RemoteWorldSource('https://worker.example', 'demo', fetchImpl as unknown as typeof fetch);
    const [hit] = await source.search('x');
    expect((await source.getNode(hit.id))?.id).toBe(target.id);
  });
});
