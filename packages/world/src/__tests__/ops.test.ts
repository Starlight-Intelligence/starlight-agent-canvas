import { describe, expect, it } from 'vitest';
import { applyOps, promoteToCanon } from '../ops.js';
import { validateWorldGraph } from '../validate.js';
import { claude, sampleGraph, T1 } from './helpers.js';

const ctx = { actor: claude };

describe('applyOps: happy path', () => {
  it('adds, updates, moves, links and removes in one atomic batch', () => {
    const graph = sampleGraph();
    const result = applyOps(graph, [
      { op: 'addNode', node: { id: 'n_new', kind: 'scene', title: 'Arrival', position: { x: 10, y: 20 }, regionId: 'r_core' } },
      { op: 'updateNode', id: 'n_a', baseVersion: 1, patch: { summary: 'Now with a summary', tags: ['lead'] } },
      { op: 'moveNodes', moves: [{ id: 'n_b', baseVersion: 4, position: { x: 1500, y: 5 }, regionId: 'r_edge' }] },
      { op: 'addEdge', edge: { from: 'n_a', to: 'n_new', relation: 'appears-in' } },
      { op: 'removeEdge', id: 'e_ab', baseVersion: 1 },
    ], ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.applied).toBe(5);
    // Version floor is 4 (n_b). Five changes take 5..9.
    expect(result.graph.world.version).toBe(9);
    expect(result.graph.world.updatedAt).toBe(T1);

    const added = result.graph.nodes.find((n) => n.id === 'n_new')!;
    expect(added).toMatchObject({ worldId: 'testland', version: 5, canon: { status: 'draft' }, createdBy: claude, updatedAt: T1 });

    const updated = result.graph.nodes.find((n) => n.id === 'n_a')!;
    expect(updated).toMatchObject({ summary: 'Now with a summary', tags: ['lead'], version: 6 });
    expect(updated.createdBy.harness).toBe('importer');

    const moved = result.graph.nodes.find((n) => n.id === 'n_b')!;
    expect(moved).toMatchObject({ position: { x: 1500, y: 5 }, regionId: 'r_edge', version: 7 });

    expect(result.graph.edges.map((e) => e.id)).not.toContain('e_ab');
    expect(result.changed.removedEdges).toEqual(['e_ab']);
    expect(validateWorldGraph(result.graph).ok).toBe(true);
  });

  it('never mutates the input graph', () => {
    const graph = sampleGraph();
    const snapshot = JSON.stringify(graph);
    applyOps(graph, [
      { op: 'updateNode', id: 'n_a', baseVersion: 1, patch: { title: 'Changed' } },
      { op: 'removeNode', id: 'n_b', baseVersion: 4 },
    ], ctx);
    expect(JSON.stringify(graph)).toBe(snapshot);
  });

  it('cascades edge removal when a node is removed', () => {
    const graph = sampleGraph();
    graph.edges = graph.edges.filter((e) => e.id !== 'e_canon');
    const result = applyOps(graph, [{ op: 'removeNode', id: 'n_b', baseVersion: 4 }], ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.graph.nodes.map((n) => n.id)).not.toContain('n_b');
    expect(result.graph.edges).toHaveLength(0);
    expect(result.changed.removedEdges).toEqual(['e_ab']);
  });

  it('allows canon nodes to move (layout is not canon)', () => {
    const result = applyOps(sampleGraph(), [{ op: 'moveNodes', moves: [{ id: 'n_canon', baseVersion: 1, position: { x: 9, y: 9 } }] }], ctx);
    expect(result.ok).toBe(true);
  });

  it('treats an empty batch as a no-op', () => {
    const graph = sampleGraph();
    const result = applyOps(graph, [], ctx);
    expect(result.ok && result.graph).toBe(graph);
  });
});

describe('applyOps: optimistic versions', () => {
  it('rejects a stale updateNode and leaves the graph untouched', () => {
    const graph = sampleGraph();
    const result = applyOps(graph, [{ op: 'updateNode', id: 'n_b', baseVersion: 3, patch: { title: 'Late' } }], ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({ code: 'STALE_VERSION', opIndex: 0, id: 'n_b', expectedVersion: 3, actualVersion: 4 });
    expect(result.graph).toBe(graph);
  });

  it('rejects stale moves, removes, edge removes and proposals', () => {
    const graph = sampleGraph();
    const stale = [
      { op: 'moveNodes', moves: [{ id: 'n_a', baseVersion: 2, position: { x: 0, y: 0 } }] },
      { op: 'removeNode', id: 'n_a', baseVersion: 7 },
      { op: 'removeEdge', id: 'e_ab', baseVersion: 2 },
      { op: 'proposeCanon', target: { type: 'node', id: 'n_a' }, baseVersion: 2 },
    ];
    for (const op of stale) {
      const result = applyOps(graph, [op], ctx);
      expect(result.ok ? 'ok' : result.error.code).toBe('STALE_VERSION');
    }
  });

  it('is atomic: a stale op late in the batch discards earlier ops', () => {
    const graph = sampleGraph();
    const result = applyOps(graph, [
      { op: 'addNode', node: { id: 'n_new', kind: 'note', title: 'x', position: { x: 0, y: 0 } } },
      { op: 'updateNode', id: 'n_a', baseVersion: 99, patch: { title: 'nope' } },
    ], ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.opIndex).toBe(1);
    expect(result.graph.nodes.map((n) => n.id)).not.toContain('n_new');
  });

  it('rejects changing the same node or edge twice in one batch', () => {
    const graph = sampleGraph();
    const twice: unknown[][] = [
      [
        { op: 'updateNode', id: 'n_a', baseVersion: 1, patch: { title: 'one' } },
        { op: 'updateNode', id: 'n_a', baseVersion: 1, patch: { title: 'two' } },
      ],
      [{ op: 'moveNodes', moves: [{ id: 'n_a', baseVersion: 1, position: { x: 1, y: 1 } }, { id: 'n_a', baseVersion: 1, position: { x: 2, y: 2 } }] }],
      [
        { op: 'addNode', node: { id: 'n_new', kind: 'note', title: 'x', position: { x: 0, y: 0 } } },
        { op: 'updateNode', id: 'n_new', baseVersion: 4, patch: { title: 'y' } },
      ],
      [
        { op: 'removeEdge', id: 'e_ab', baseVersion: 1 },
        { op: 'addEdge', edge: { id: 'e_ab', from: 'n_a', to: 'n_b', relation: 'located-at' } },
      ],
    ];
    for (const ops of twice) {
      const result = applyOps(graph, ops, ctx);
      expect(result.ok ? 'ok' : result.error.code).toBe('INVALID_OP');
    }
  });

  it('never reuses a version when an id is removed and created again', () => {
    const graph = sampleGraph();
    graph.edges = graph.edges.filter((e) => e.id !== 'e_canon');
    // The client saw e_ab at version 1, then someone removed and re-added it.
    const removed = applyOps(graph, [{ op: 'removeEdge', id: 'e_ab', baseVersion: 1 }], ctx);
    expect(removed.ok).toBe(true);
    if (!removed.ok) return;
    const readded = applyOps(removed.graph, [{ op: 'addEdge', edge: { id: 'e_ab', from: 'n_a', to: 'n_b', relation: 'located-at' } }], ctx);
    expect(readded.ok).toBe(true);
    if (!readded.ok) return;
    const fresh = readded.graph.edges.find((e) => e.id === 'e_ab')!;
    expect(fresh.version).toBeGreaterThan(1);
    // A delayed remove carrying the old version must not hit the replacement.
    const stale = applyOps(readded.graph, [{ op: 'removeEdge', id: 'e_ab', baseVersion: 1 }], ctx);
    expect(stale.ok ? 'ok' : stale.error.code).toBe('STALE_VERSION');

    // Same for a node recreated with an explicit id.
    const gone = applyOps(readded.graph, [{ op: 'removeNode', id: 'n_a', baseVersion: 1 }], ctx);
    expect(gone.ok).toBe(true);
    if (!gone.ok) return;
    const back = applyOps(gone.graph, [{ op: 'addNode', node: { id: 'n_a', kind: 'character', title: 'Alpha again', position: { x: 0, y: 0 } } }], ctx);
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    const staleEdit = applyOps(back.graph, [{ op: 'updateNode', id: 'n_a', baseVersion: 1, patch: { title: 'late' } }], ctx);
    expect(staleEdit.ok ? 'ok' : staleEdit.error.code).toBe('STALE_VERSION');
  });

  it('keeps world.version at or above every entity version', () => {
    const result = applyOps(sampleGraph(), [
      { op: 'updateNode', id: 'n_a', baseVersion: 1, patch: { title: 'x' } },
      { op: 'removeEdge', id: 'e_ab', baseVersion: 1 },
    ], ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const max = Math.max(...result.graph.nodes.map((n) => n.version), ...result.graph.edges.map((e) => e.version));
    expect(result.graph.world.version).toBeGreaterThanOrEqual(max);
    expect(result.graph.world.version).toBe(6);
  });
});

describe('applyOps: canon gate', () => {
  it('refuses addNode with canon.status canon', () => {
    const result = applyOps(sampleGraph(), [
      { op: 'addNode', node: { id: 'n_x', kind: 'god', title: 'Usurper', position: { x: 0, y: 0 }, canon: { status: 'canon', ref: 'https://example.com/pr/1' } } },
    ], ctx);
    expect(result.ok ? 'ok' : result.error.code).toBe('CANON_FORBIDDEN');
  });

  it('refuses addEdge with canon.status canon', () => {
    const result = applyOps(sampleGraph(), [
      { op: 'addEdge', edge: { from: 'n_a', to: 'n_b', relation: 'member-of', canon: { status: 'canon', ref: 'https://example.com/pr/1' } } },
    ], ctx);
    expect(result.ok ? 'ok' : result.error.code).toBe('CANON_FORBIDDEN');
  });

  it('refuses canon in an update patch', () => {
    const result = applyOps(sampleGraph(), [
      { op: 'updateNode', id: 'n_a', baseVersion: 1, patch: { canon: { status: 'canon', ref: 'https://example.com/pr/1' } } },
    ], ctx);
    expect(result.ok ? 'ok' : result.error.code).toBe('CANON_FORBIDDEN');
  });

  it('refuses smuggled fields such as version or createdBy', () => {
    const result = applyOps(sampleGraph(), [
      { op: 'updateNode', id: 'n_a', baseVersion: 1, patch: { title: 'x', version: 50 } },
    ], ctx);
    expect(result.ok ? 'ok' : result.error.code).toBe('INVALID_OP');
  });

  it('refuses edits and removal of canon nodes and edges', () => {
    const graph = sampleGraph();
    const attempts = [
      { op: 'updateNode', id: 'n_canon', baseVersion: 1, patch: { title: 'Rewritten' } },
      { op: 'removeNode', id: 'n_canon', baseVersion: 1 },
      { op: 'removeEdge', id: 'e_canon', baseVersion: 2 },
      { op: 'proposeCanon', target: { type: 'node', id: 'n_canon' }, baseVersion: 1 },
    ];
    for (const op of attempts) {
      const result = applyOps(graph, [op], ctx);
      expect(result.ok ? 'ok' : result.error.code).toBe('CANON_LOCKED');
    }
    // n_b has a canon edge attached, so removing it is refused too.
    const cascade = applyOps(graph, [{ op: 'removeNode', id: 'n_b', baseVersion: 4 }], ctx);
    expect(cascade.ok ? 'ok' : cascade.error.code).toBe('CANON_LOCKED');
  });

  it('proposeCanon moves a node to proposed, never canon, and reports the proposal', () => {
    const result = applyOps(sampleGraph(), [
      { op: 'proposeCanon', target: { type: 'node', id: 'n_a' }, baseVersion: 1, note: 'Ready for review' },
    ], ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const proposed = result.graph.nodes.find((n) => n.id === 'n_a')!;
    expect(proposed.canon).toEqual({ status: 'proposed' });
    expect(proposed.version).toBe(5);
    expect(result.proposals).toEqual([
      { targetType: 'node', id: 'n_a', title: 'Alpha', version: 5, ref: undefined, note: 'Ready for review', proposedBy: claude },
    ]);
  });

  it('an edit after a proposal drops the node back to draft', () => {
    const first = applyOps(sampleGraph(), [{ op: 'proposeCanon', target: { type: 'node', id: 'n_a' }, baseVersion: 1 }], ctx);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = applyOps(first.graph, [{ op: 'updateNode', id: 'n_a', baseVersion: 5, patch: { body: 'changed' } }], ctx);
    expect(second.ok && second.graph.nodes.find((n) => n.id === 'n_a')?.canon.status).toBe('draft');
  });

  it('promoteToCanon is the only path to canon and needs an https ref', () => {
    const graph = sampleGraph();
    expect(() => promoteToCanon(graph, { type: 'node', id: 'n_a' }, 'not a url', claude)).toThrow();
    const promoted = promoteToCanon(graph, { type: 'node', id: 'n_a' }, 'https://github.com/example/canon/pull/3', claude);
    expect(promoted.nodes.find((n) => n.id === 'n_a')?.canon).toEqual({ status: 'canon', ref: 'https://github.com/example/canon/pull/3' });
    expect(graph.nodes.find((n) => n.id === 'n_a')?.canon.status).toBe('draft');
  });
});

describe('applyOps: references and context', () => {
  it('rejects unknown nodes, unknown regions, duplicates and bad context', () => {
    const graph = sampleGraph();
    const cases: [unknown, string][] = [
      [{ op: 'updateNode', id: 'n_missing', baseVersion: 1, patch: { title: 'x' } }, 'NOT_FOUND'],
      [{ op: 'addEdge', edge: { from: 'n_a', to: 'n_missing', relation: 'references' } }, 'NOT_FOUND'],
      [{ op: 'addNode', node: { id: 'n_a', kind: 'note', title: 'dup', position: { x: 0, y: 0 } } }, 'DUPLICATE_ID'],
      [{ op: 'addNode', node: { id: 'n_z', kind: 'note', title: 'z', position: { x: 0, y: 0 }, regionId: 'r_nowhere' } }, 'INVALID_REFERENCE'],
      [{ op: 'teleport', id: 'n_a' }, 'INVALID_OP'],
      [{ op: { toString: 1 }, id: 'n_a' }, 'INVALID_OP'],
      [{ op: 'proposeCanon', target: { type: 'node', id: 'n_a' }, baseVersion: 1, ref: 'javascript:alert(1)' }, 'INVALID_OP'],
    ];
    for (const [op, code] of cases) {
      const result = applyOps(graph, [op], ctx);
      expect(result.ok ? 'ok' : result.error.code).toBe(code);
    }
    const noActor = applyOps(graph, [], { actor: { harness: 'claude', at: 'yesterday' } });
    expect(noActor.ok ? 'ok' : noActor.error.code).toBe('INVALID_CONTEXT');
  });
});
