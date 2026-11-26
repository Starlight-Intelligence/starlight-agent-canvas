import { applyOps, WORLD_GRAPH_SCHEMA_VERSION, type WorldGraph } from '@starlight-agent-canvas/world';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { WorldAgent, WriteResult } from '../src/world-agent.js';
import { agentFor, claude, codex, human, nodeOp, worldName } from './helpers.js';

describe('WorldAgent op application', () => {
  it('applies a batch, bumps versions and logs the harness', async () => {
    const agent = await agentFor(worldName());
    const result = (await agent.applyBatch([
      nodeOp('n_a', 10, 10),
      nodeOp('n_b', 400, 10),
      { op: 'addEdge', edge: { from: 'n_a', to: 'n_b', relation: 'bonded-to' } },
    ], claude)) as WriteResult;
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // One world-wide version counter: each change takes the next value.
    expect(result.version).toBe(3);
    expect(result.nodes.map((n) => [n.id, n.version]).sort()).toEqual([['n_a', 1], ['n_b', 2]]);
    expect(result.edges[0]!.version).toBe(3);
    expect(result.nodes[0]!.createdBy).toMatchObject({ harness: 'claude', actor: 'claude-test' });
    expect(result.edges).toHaveLength(1);

    const update = (await agent.applyBatch([
      { op: 'updateNode', id: 'n_a', baseVersion: 1, patch: { summary: 'First of the line.' } },
    ], human)) as WriteResult;
    expect(update.ok).toBe(true);
    if (update.ok) {
      expect(update.version).toBe(4);
      expect(update.nodes[0]).toMatchObject({ id: 'n_a', version: 4, summary: 'First of the line.' });
    }

    const log = await agent.listOps();
    expect(log.map((e) => [e.worldVersion, e.harness, e.actor])).toEqual([
      [3, 'claude', 'claude-test'],
      [4, 'human', 'frank@example.com'],
    ]);
    const info = await agent.getWorldInfo();
    expect(info.world.version).toBe(4);
    expect(info.counts).toMatchObject({ nodes: 2, edges: 1 });
  });

  it('rejects a stale baseVersion with expected and actual versions, and writes nothing', async () => {
    const agent = await agentFor(worldName());
    await agent.applyBatch([nodeOp('n_a')], claude);
    await agent.applyBatch([{ op: 'updateNode', id: 'n_a', baseVersion: 1, patch: { title: 'Renamed by Codex' } }], codex);

    const stale = (await agent.applyBatch([
      nodeOp('n_new'),
      { op: 'updateNode', id: 'n_a', baseVersion: 1, patch: { title: 'Claude, from an old read' } },
    ], claude)) as WriteResult;
    expect(stale.ok).toBe(false);
    if (stale.ok) return;
    expect(stale.error).toMatchObject({ code: 'STALE_VERSION', id: 'n_a', expectedVersion: 1, actualVersion: 2, opIndex: 1 });
    expect(stale.error.message).toMatch(/Re-read and retry/);
    expect(stale.version).toBe(2);
    // Atomic: the addNode in the same batch did not land.
    expect(await agent.getNodesById(['n_new'])).toEqual([]);
    expect(await agent.listOps()).toHaveLength(2);
  });

  it('refuses canon from ops, keeps canon out of storage, and records proposals', async () => {
    const agent = await agentFor(worldName());
    const forbidden = (await agent.applyBatch([nodeOp('n_c', 0, 0, { canon: { status: 'canon', ref: 'https://github.com/x/y/pull/1' } })], claude)) as WriteResult;
    expect(forbidden.ok).toBe(false);
    if (!forbidden.ok) expect(forbidden.error.code).toBe('CANON_FORBIDDEN');

    const smuggled = (await agent.applyBatch([
      { op: 'updateNode', id: 'n_x', baseVersion: 1, patch: { canon: { status: 'canon' } } },
    ], claude)) as WriteResult;
    expect(smuggled.ok).toBe(false);
    if (!smuggled.ok) expect(smuggled.error.code).toBe('CANON_FORBIDDEN');

    await agent.applyBatch([nodeOp('n_gate'), nodeOp('n_god')], claude);
    const proposed = (await agent.proposeCanon({
      title: 'Add the Foundation gate',
      targets: [{ type: 'node', id: 'n_gate', baseVersion: 1 }, { type: 'node', id: 'n_god', baseVersion: 2 }],
      rationale: 'Matches the locked gate list.',
    }, codex)) as WriteResult & { proposalId?: string };
    expect(proposed.ok).toBe(true);
    if (!proposed.ok) return;
    expect(proposed.proposalId).toMatch(/^cp_canon_/);
    expect(proposed.nodes.every((n) => n.canon.status === 'proposed')).toBe(true);

    const proposals = await agent.listProposals('open');
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ title: 'Add the Foundation gate', nodeIds: ['n_gate', 'n_god'], rationale: 'Matches the locked gate list.', harness: 'codex', prUrl: null });

    // Nothing in the DO is canon.
    await runInDurableObject(agent, (instance: WorldAgent, state) => {
      const rows = state.storage.sql.exec("SELECT COUNT(*) AS n FROM nodes WHERE canon_status = 'canon'").one();
      expect(Number(rows.n)).toBe(0);
      expect(instance.name).toBeTruthy();
    });
  });

  it('removeNode drops incident edges loaded through the subgraph', async () => {
    const agent = await agentFor(worldName());
    await agent.applyBatch([
      nodeOp('n_a'), nodeOp('n_b'), nodeOp('n_c'),
      { op: 'addEdge', edge: { from: 'n_a', to: 'n_b', relation: 'rules' } },
      { op: 'addEdge', edge: { from: 'n_c', to: 'n_a', relation: 'member-of' } },
      { op: 'addEdge', edge: { from: 'n_b', to: 'n_c', relation: 'precedes' } },
    ], human);
    const removed = (await agent.applyBatch([{ op: 'removeNode', id: 'n_a', baseVersion: 1 }], human)) as WriteResult;
    expect(removed.ok).toBe(true);
    if (removed.ok) {
      expect(removed.removedNodes).toEqual(['n_a']);
      expect(removed.removedEdges).toHaveLength(2);
    }
    expect((await agent.getWorldInfo()).counts).toMatchObject({ nodes: 2, edges: 1 });
  });

  it('gives the same answer as applyOps on the full graph (subgraph equivalence)', async () => {
    const agent = await agentFor(worldName());
    const seed = [nodeOp('n_a', 0, 0), nodeOp('n_b', 100, 0), { op: 'addEdge', edge: { from: 'n_a', to: 'n_b', relation: 'precedes' } }];
    await agent.applyBatch(seed, claude);
    const batches: unknown[][] = [
      [{ op: 'addEdge', edge: { from: 'n_a', to: 'n_b', relation: 'precedes' } }], // DUPLICATE_ID via deterministic id
      [{ op: 'addEdge', edge: { from: 'n_a', to: 'n_missing', relation: 'precedes' } }], // NOT_FOUND
      [nodeOp('n_a')], // DUPLICATE_ID
      [{ op: 'moveNodes', moves: [{ id: 'n_b', baseVersion: 1, position: { x: 5, y: 5 }, regionId: 'r_none' }] }], // INVALID_REFERENCE
    ];
    const full = applyOps(
      { schemaVersion: WORLD_GRAPH_SCHEMA_VERSION, world: { id: 'eq', title: 'eq', summary: '', version: 0, regions: [], updatedAt: new Date(0).toISOString() }, nodes: [], edges: [] } as WorldGraph,
      seed,
      { actor: { harness: 'claude', at: new Date().toISOString() } },
    );
    expect(full.ok).toBe(true);
    for (const batch of batches) {
      const viaAgent = (await agent.applyBatch(batch, claude)) as WriteResult;
      const viaFull = applyOps(full.graph, batch, { actor: { harness: 'claude', at: new Date().toISOString() } });
      expect(viaAgent.ok).toBe(false);
      expect(viaFull.ok).toBe(false);
      if (!viaAgent.ok && !viaFull.ok) expect(viaAgent.error.code).toBe(viaFull.error.code);
    }
  });

  it('Agent state stays small and never holds nodes', async () => {
    const agent = await agentFor(worldName());
    await agent.applyBatch([nodeOp('n_a'), nodeOp('n_b')], claude);
    await runInDurableObject(agent, (instance: WorldAgent) => {
      expect(instance.state).toMatchObject({ version: 2, nodeCount: 2, edgeCount: 0, lastChange: { harness: 'claude' } });
      expect(JSON.stringify(instance.state)).not.toContain('n_a');
    });
  });
});
