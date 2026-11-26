import { lstat, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runImportWhiteboard } from '../cli/run-import.js';
import { importClaudeWhiteboard } from '../import/claude-whiteboard.js';
import { applyOps, promoteToCanon, VersionExhaustedError } from '../ops.js';
import { validateWorldGraph } from '../validate.js';
import { MAX_TILES_HARD_LIMIT, MAX_TILES_PER_QUERY, TILE_SIZE, tileKeysForBounds } from '../zoom.js';
import { claude, sampleGraph } from './helpers.js';

const ctx = { actor: claude };

function exportWith(elements: unknown): unknown {
  return { title: 'Codex Cases', exportedAt: '2026-01-02', format: 'claude-whiteboard v1 elements', elements };
}

function graphAtVersion(version: number) {
  const graph = sampleGraph();
  return { ...graph, world: { ...graph.world, version } };
}

const addNode = (id: string) => ({ op: 'addNode', node: { id, kind: 'character', title: id, position: { x: 0, y: 0 }, regionId: 'r_core' } });

describe('#64 Codex re-review 1: the version counter cannot pass MAX_SAFE_INTEGER', () => {
  it('accepts a change that lands exactly on MAX_SAFE_INTEGER', () => {
    const result = applyOps(graphAtVersion(Number.MAX_SAFE_INTEGER - 1), [addNode('n_last')], ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.graph.world.version).toBe(Number.MAX_SAFE_INTEGER);
    expect(validateWorldGraph(result.graph).ok).toBe(true);
  });

  it('rejects a batch that would overflow with VERSION_EXHAUSTED and leaves the graph unchanged', () => {
    const graph = graphAtVersion(Number.MAX_SAFE_INTEGER - 1);
    const result = applyOps(graph, [addNode('n_one'), addNode('n_two')], ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VERSION_EXHAUSTED');
    expect(result.error.opIndex).toBe(1);
    expect(result.graph).toBe(graph);
  });

  it('rejects removals at the limit too', () => {
    const result = applyOps(graphAtVersion(Number.MAX_SAFE_INTEGER), [{ op: 'removeEdge', id: 'e_ab', baseVersion: 1 }], ctx);
    expect(result.ok ? 'ok' : result.error.code).toBe('VERSION_EXHAUSTED');
  });

  it('promoteToCanon throws a structured VERSION_EXHAUSTED error instead of overflowing', () => {
    const graph = graphAtVersion(Number.MAX_SAFE_INTEGER);
    let caught: unknown;
    try {
      promoteToCanon(graph, { type: 'node', id: 'n_a' }, 'https://github.com/example/canon/pull/9', claude);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(VersionExhaustedError);
    expect((caught as VersionExhaustedError).code).toBe('VERSION_EXHAUSTED');
    const ok = promoteToCanon(graphAtVersion(Number.MAX_SAFE_INTEGER - 1), { type: 'node', id: 'n_a' }, 'https://github.com/example/canon/pull/9', claude);
    expect(ok.world.version).toBe(Number.MAX_SAFE_INTEGER);
    expect(validateWorldGraph(ok).ok).toBe(true);
  });
});

describe('#64 Codex re-review 2: cascading delete respects once-per-entity', () => {
  it('rejects add-edge then delete-endpoint instead of reporting a phantom removed edge', () => {
    const graph = sampleGraph();
    const result = applyOps(graph, [
      { op: 'addEdge', edge: { id: 'e_new', from: 'n_b', to: 'n_a', relation: 'references' } },
      { op: 'removeNode', id: 'n_a', baseVersion: 1 },
    ], ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_OP');
    expect(result.error.id).toBe('e_new');
    expect(result.error.opIndex).toBe(1);
    expect(result.graph).toBe(graph);
  });

  it('rejects a cascade over an edge already changed in the batch', () => {
    const result = applyOps(sampleGraph(), [
      { op: 'proposeCanon', target: { type: 'edge', id: 'e_ab' }, baseVersion: 1 },
      { op: 'removeNode', id: 'n_a', baseVersion: 1 },
    ], ctx);
    expect(result.ok ? 'ok' : result.error.code).toBe('INVALID_OP');
  });

  it('still cascades over untouched pre-existing edges and reports only those', () => {
    const result = applyOps(sampleGraph(), [{ op: 'removeNode', id: 'n_a', baseVersion: 1 }], ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed.removedEdges).toEqual(['e_ab']);
  });

  it('an explicit removeEdge before removing the endpoint is still fine', () => {
    const result = applyOps(sampleGraph(), [
      { op: 'removeEdge', id: 'e_ab', baseVersion: 1 },
      { op: 'removeNode', id: 'n_a', baseVersion: 1 },
    ], ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed.removedEdges).toEqual(['e_ab']);
  });
});

describe('#64 Codex re-review 3: maxTiles must be a finite positive integer', () => {
  // 100 x 100 tiles = 10_000 > MAX_TILES_PER_QUERY.
  const big = { x: 0, y: 0, w: TILE_SIZE * 99, h: TILE_SIZE * 99 };

  it('rejects NaN, Infinity, zero, negatives and fractions', () => {
    for (const maxTiles of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, -1, 2.5]) {
      expect(() => tileKeysForBounds(big, TILE_SIZE, maxTiles), String(maxTiles)).toThrow(RangeError);
    }
  });

  it('a larger maxTiles still enumerates normally below the hard ceiling', () => {
    const atCap = { x: 0, y: 0, w: TILE_SIZE * 63, h: TILE_SIZE * 63 }; // 64 x 64 = 4096
    expect(tileKeysForBounds(atCap, TILE_SIZE, 1_000_000)).toHaveLength(MAX_TILES_PER_QUERY);
    const overCeiling = { x: 0, y: 0, w: TILE_SIZE * 256, h: TILE_SIZE * 256 }; // 257 x 257 > 65,536
    expect(() => tileKeysForBounds(overCeiling, TILE_SIZE, Number.MAX_SAFE_INTEGER)).toThrow(RangeError);
    expect(MAX_TILES_HARD_LIMIT).toBe(65_536);
  });

  it('still honours a smaller maxTiles', () => {
    expect(() => tileKeysForBounds({ x: 0, y: 0, w: TILE_SIZE, h: TILE_SIZE }, TILE_SIZE, 3)).toThrow(RangeError);
    expect(tileKeysForBounds({ x: 0, y: 0, w: TILE_SIZE, h: TILE_SIZE }, TILE_SIZE, 4)).toHaveLength(4);
  });
});

describe('#64 Codex re-review 4: over-long image hrefs are filtered, not fatal', () => {
  it('drops an http(s) href over 2048 characters and reports it', () => {
    const longHref = `https://example.com/${'a'.repeat(2100)}`;
    const result = importClaudeWhiteboard(exportWith({
      img: { type: 'image', x: 0, y: 0, w: 200, h: 200, src: '/_blob/abc.png', href: longHref },
      ok: { type: 'image', x: 0, y: 1000, w: 200, h: 200, src: '/_blob/def.png', href: 'https://example.com/fine' },
    }), { worldId: 'codex' });
    expect(validateWorldGraph(result.graph).ok).toBe(true);
    const images = result.graph.nodes.filter((n) => n.kind === 'image');
    expect(images).toHaveLength(2);
    const dropped = images.find((n) => (n.meta.import as { elementIds: string[] }).elementIds.includes('img'))!;
    expect(dropped.media[0].href).toBeUndefined();
    expect(dropped.media[0].originalSrc).toBe('/_blob/abc.png');
    expect(images.find((n) => n.media[0].href === 'https://example.com/fine')).toBeTruthy();
    expect(dropped.meta.originalHref).toBe(longHref);
    expect(result.report.warnings.some((w) => w.includes('img'))).toBe(true);
  });
});

describe('#64 Codex re-review 5: gate lines with more than two names', () => {
  it('reports the names it drops instead of claiming a full expansion', () => {
    const result = importClaudeWhiteboard(exportWith({
      h: { type: 'text', size: 'large', text: '01 · Stone', x: 0, y: 0 },
      p: { type: 'text', size: 'body', text: 'Bram × Tusk × Fen', x: 0, y: 50 },
      d: { type: 'text', size: 'body', text: 'Weight and patience.', x: 0, y: 90 },
    }), { worldId: 'codex' });
    expect(result.graph.nodes.filter((n) => n.kind !== 'world').map((n) => n.title).sort()).toEqual(['Bram', 'Stone Gate', 'Tusk']);
    const disposition = result.elements.p;
    expect(disposition.as).toBe('expanded');
    if (disposition.as !== 'expanded') return;
    expect(disposition.nodeIds).toHaveLength(2);
    expect(disposition.dropped).toEqual(['Fen']);
    expect(result.report.warnings.some((w) => w.includes('3 names') && w.includes('p'))).toBe(true);
    const gate = result.graph.nodes.find((n) => n.title === 'Stone Gate')!;
    expect((gate.meta.gate as { unexpandedNames?: string[] }).unexpandedNames).toEqual(['Fen']);
  });

  it('two names expand fully with nothing dropped', () => {
    const result = importClaudeWhiteboard(exportWith({
      h: { type: 'text', size: 'large', text: '01 · Stone', x: 0, y: 0 },
      p: { type: 'text', size: 'body', text: 'Bram × Tusk', x: 0, y: 50 },
    }), { worldId: 'codex' });
    const disposition = result.elements.p;
    expect(disposition.as === 'expanded' && disposition.dropped).toBeFalsy();
  });
});

describe('#64 Codex re-review 6: CLI temp files are created exclusively at unpredictable paths', () => {
  it('does not follow a planted file or symlink at the old predictable temp path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'world-cli-tmp-'));
    const input = join(dir, 'board.json');
    await writeFile(input, JSON.stringify(exportWith({ t1: { type: 'text', size: 'body', text: 'A note.', x: 0, y: 0 } })));
    const victim = join(dir, 'victim.txt');
    await writeFile(victim, 'do not touch');
    const out = join(dir, 'world.json');
    await symlink(victim, `${out}.${process.pid}.tmp`);
    const code = await runImportWhiteboard(['--in', input, '--out', out], { stdout: () => undefined, stderr: () => undefined });
    expect(code).toBe(0);
    expect(await readFile(victim, 'utf8')).toBe('do not touch');
    expect((await lstat(out)).isSymbolicLink()).toBe(false);
    expect(JSON.parse(await readFile(out, 'utf8')).schemaVersion).toBe('starlight.worldGraph.v1');
  });
});
