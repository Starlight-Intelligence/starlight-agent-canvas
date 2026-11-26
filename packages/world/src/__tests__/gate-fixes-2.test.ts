import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runImportWhiteboard } from '../cli/run-import.js';
import { importClaudeWhiteboard } from '../import/claude-whiteboard.js';
import { applyOps, promoteToCanon } from '../ops.js';
import { validateWorldGraph } from '../validate.js';
import { MAX_TILES_HARD_LIMIT, tileKeysForBounds } from '../zoom.js';
import { claude, sampleGraph } from './helpers.js';

// Findings from the starlight-signoff review of 0da1cf7 on #64.

const ctx = { actor: claude };
const fixture = JSON.parse(readFileSync(new URL('./fixtures/whiteboard-sample.json', import.meta.url), 'utf8')) as {
  elements: Record<string, Record<string, unknown>>;
} & Record<string, unknown>;
const withElements = (extra: Record<string, Record<string, unknown>>) => ({ ...fixture, elements: { ...fixture.elements, ...extra } });

describe('version counter exhaustion', () => {
  it('applyOps refuses a change once the counter is at MAX_SAFE_INTEGER', () => {
    const graph = sampleGraph();
    graph.world.version = Number.MAX_SAFE_INTEGER;
    const result = applyOps(graph, [{ op: 'updateNode', id: 'n_a', baseVersion: 1, patch: { title: 'x' } }], ctx);
    expect(result.ok ? 'ok' : result.error.code).toBe('VERSION_EXHAUSTED');
    expect(result.graph).toBe(graph);
  });

  it('the last safe version is still usable and the result validates', () => {
    const graph = sampleGraph();
    graph.world.version = Number.MAX_SAFE_INTEGER - 1;
    const result = applyOps(graph, [{ op: 'updateNode', id: 'n_a', baseVersion: 1, patch: { title: 'x' } }], ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.graph.world.version).toBe(Number.MAX_SAFE_INTEGER);
    expect(validateWorldGraph(result.graph).ok).toBe(true);
  });

  it('promoteToCanon refuses when the counter is exhausted', () => {
    const graph = sampleGraph();
    graph.world.version = Number.MAX_SAFE_INTEGER;
    expect(() => promoteToCanon(graph, { type: 'node', id: 'n_a' }, 'https://github.com/example/canon/pull/9', claude)).toThrow(/exhausted/);
  });
});

describe('removeNode cascade obeys once-per-entity', () => {
  it('refuses to add an edge and then cascade it away in the same batch', () => {
    const graph = sampleGraph();
    graph.edges = graph.edges.filter((e) => e.id !== 'e_canon');
    const result = applyOps(graph, [
      { op: 'addEdge', edge: { id: 'e_new', from: 'n_a', to: 'n_b', relation: 'references' } },
      { op: 'removeNode', id: 'n_b', baseVersion: 4 },
    ], ctx);
    expect(result.ok ? 'ok' : result.error.code).toBe('INVALID_OP');
  });

  it('refuses to propose an edge and then cascade it away in the same batch', () => {
    const graph = sampleGraph();
    graph.edges = graph.edges.filter((e) => e.id !== 'e_canon');
    const result = applyOps(graph, [
      { op: 'proposeCanon', target: { type: 'edge', id: 'e_ab' }, baseVersion: 1 },
      { op: 'removeNode', id: 'n_a', baseVersion: 1 },
    ], ctx);
    expect(result.ok ? 'ok' : result.error.code).toBe('INVALID_OP');
  });

  it('still cascades untouched edges', () => {
    const graph = sampleGraph();
    graph.edges = graph.edges.filter((e) => e.id !== 'e_canon');
    const result = applyOps(graph, [{ op: 'removeNode', id: 'n_a', baseVersion: 1 }], ctx);
    expect(result.ok && result.changed.removedEdges).toEqual(['e_ab']);
  });
});

describe('tileKeysForBounds maxTiles validation', () => {
  it('rejects NaN, Infinity, zero and fractional limits', () => {
    for (const maxTiles of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1, 2.5]) {
      expect(() => tileKeysForBounds({ x: 0, y: 0, w: 10, h: 10 }, 2048, maxTiles)).toThrow(RangeError);
    }
  });

  it('clamps a large caller limit to the hard ceiling', () => {
    const side = 300; // 301 x 301 tiles > 65,536
    expect((side + 1) ** 2).toBeGreaterThan(MAX_TILES_HARD_LIMIT);
    expect(() => tileKeysForBounds({ x: 0, y: 0, w: 2048 * side, h: 2048 * side }, 2048, Number.MAX_SAFE_INTEGER)).toThrow(RangeError);
  });
});

describe('importer: links and gate lines the schema cannot hold', () => {
  it('keeps the import going when an image href is longer than the schema allows', () => {
    const href = `https://example.com/${'a'.repeat(3000)}`;
    const result = importClaudeWhiteboard(withElements({
      i5: { type: 'image', src: '/_blob/ddd', href, x: 500, y: 2100, w: 400, h: 300 },
    }), { worldId: 'testland' });
    const image = result.graph.nodes.find((n) => n.kind === 'image' && (n.meta.import as { elementIds: string[] }).elementIds.includes('i5'))!;
    expect(image.media[0].href).toBeUndefined();
    expect(image.meta.originalHref).toBe(href);
    expect(result.report.warnings.some((w) => w.includes('i5'))).toBe(true);
    expect(validateWorldGraph(result.graph).ok).toBe(true);
  });

  it('keeps extra names from a three-name gate line and warns', () => {
    const result = importClaudeWhiteboard(withElements({
      t5: { type: 'text', size: 'large', color: '#f6f7f9', text: 'Bram × Tusk × Pebble', x: 0, y: 1558 },
    }), { worldId: 'testland' });
    const gate = result.graph.nodes.find((n) => n.title === 'Stone Gate')!;
    expect(gate.body).toBe('Bram × Tusk × Pebble');
    expect((gate.meta.gate as { unexpandedNames?: string[] }).unexpandedNames).toEqual(['Pebble']);
    expect(result.report.warnings.some((w) => w.includes('3 names'))).toBe(true);
    expect(result.graph.nodes.some((n) => n.title === 'Bram')).toBe(true);
    expect(result.graph.nodes.some((n) => n.title === 'Tusk')).toBe(true);
  });
});

describe('CLI atomic write', () => {
  it('does not truncate a file at the old predictable temp path and leaves no temp files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'world-cli-tmp-'));
    const input = join(dir, 'board.json');
    await writeFile(input, JSON.stringify(fixture));
    const out = join(dir, 'world.json');
    const decoy = `${out}.${process.pid}.tmp`;
    await writeFile(decoy, 'keep me');
    const code = await runImportWhiteboard(['--in', input, '--out', out, '--world-id', 'testland'], { stdout: () => undefined, stderr: () => undefined });
    expect(code).toBe(0);
    expect(await readFile(decoy, 'utf8')).toBe('keep me');
    expect(validateWorldGraph(JSON.parse(await readFile(out, 'utf8'))).ok).toBe(true);
    const leftovers = (await readdir(dir)).filter((name) => name.endsWith('.tmp') && name !== `world.json.${process.pid}.tmp`);
    expect(leftovers).toEqual([]);
  });
});
