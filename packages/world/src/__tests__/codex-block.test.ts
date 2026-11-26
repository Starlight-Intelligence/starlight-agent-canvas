import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runImportWhiteboard } from '../cli/run-import.js';
import { importClaudeWhiteboard } from '../import/claude-whiteboard.js';
import { applyOps } from '../ops.js';
import { mediaSchema, worldGraphSchema } from '../schemas.js';
import { validateWorldGraph } from '../validate.js';
import { MAX_TILES_PER_QUERY, tileKeysForBounds } from '../zoom.js';
import { claude, sampleGraph } from './helpers.js';

const ctx = { actor: claude };

function exportWith(elements: unknown, extra: Record<string, unknown> = {}): unknown {
  return { title: 'Codex Cases', exportedAt: '2026-01-02', format: 'claude-whiteboard v1 elements', elements, ...extra };
}

describe('#64 Codex block 1: versions are never reused after delete + recreate', () => {
  const addA = { op: 'addNode', node: { id: 'n_a', kind: 'character', title: 'Alpha again', position: { x: 0, y: 0 }, regionId: 'r_core' } };

  it('a stale update aimed at a removed node cannot hit its replacement (across batches)', () => {
    const removed = applyOps(sampleGraph(), [{ op: 'removeNode', id: 'n_a', baseVersion: 1 }], ctx);
    expect(removed.ok).toBe(true);
    if (!removed.ok) return;
    const recreated = applyOps(removed.graph, [addA], ctx);
    expect(recreated.ok).toBe(true);
    if (!recreated.ok) return;
    const replacement = recreated.graph.nodes.find((n) => n.id === 'n_a')!;
    expect(replacement.version).toBeGreaterThan(1);
    const stale = applyOps(recreated.graph, [{ op: 'updateNode', id: 'n_a', baseVersion: 1, patch: { summary: 'stale edit' } }], ctx);
    expect(stale.ok).toBe(false);
    if (stale.ok) return;
    expect(stale.error.code).toBe('STALE_VERSION');
    const staleDelete = applyOps(recreated.graph, [{ op: 'removeNode', id: 'n_a', baseVersion: 1 }], ctx);
    expect(staleDelete.ok).toBe(false);
    expect(validateWorldGraph(recreated.graph).ok).toBe(true);
    expect(worldGraphSchema.parse(recreated.graph).world.retiredVersion).toBeGreaterThanOrEqual(1);
  });

  it('holds within one batch and for edges', () => {
    const result = applyOps(sampleGraph(), [
      { op: 'removeEdge', id: 'e_ab', baseVersion: 1 },
      { op: 'addEdge', edge: { id: 'e_ab', from: 'n_a', to: 'n_b', relation: 'located-at' } },
    ], ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const edge = result.graph.edges.find((e) => e.id === 'e_ab')!;
    expect(edge.version).toBeGreaterThan(1);
    expect(applyOps(result.graph, [{ op: 'removeEdge', id: 'e_ab', baseVersion: 1 }], ctx).ok).toBe(false);
  });

  it('a fresh world still starts new entities at version 1', () => {
    const result = applyOps(sampleGraph(), [{ op: 'addNode', node: { id: 'n_new', kind: 'note', title: 'New', position: { x: 1, y: 1 } } }], ctx);
    expect(result.ok && result.graph.nodes.find((n) => n.id === 'n_new')!.version).toBe(1);
  });
});

describe('#64 Codex block 2: every malformed op returns INVALID_OP', () => {
  const malformed: unknown[] = [
    JSON.parse('{"op":{"toString":1,"valueOf":1}}'),
    JSON.parse('{"op":{"toString":1}}'),
    Object.create(null),
    null,
    42,
    'addNode',
    [],
    JSON.parse('{"op":"addNode","node":{"id":"x","kind":"note","title":{"toString":1},"position":{"x":0,"y":0}}}'),
  ];
  for (const [index, op] of malformed.entries()) {
    it(`case ${index}`, () => {
      const result = applyOps(sampleGraph(), [op], ctx);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('INVALID_OP');
      expect(result.error.opIndex).toBe(0);
    });
  }

  it('a non-array batch is INVALID_OP, not a throw', () => {
    const result = applyOps(sampleGraph(), JSON.parse('{"op":"addNode"}') as unknown[], ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INVALID_OP');
    expect(applyOps(sampleGraph(), null as unknown as unknown[], ctx).ok).toBe(false);
  });
});

describe('#64 Codex block 3: tile queries are capped and precision-safe', () => {
  it('refuses finite but huge bounds instead of looping or allocating', () => {
    expect(() => tileKeysForBounds({ x: 1e300, y: 0, w: 1e300, h: 1 })).toThrow(RangeError);
    expect(() => tileKeysForBounds({ x: 2 ** 70, y: 0, w: 1, h: 1 })).toThrow(RangeError);
    expect(() => tileKeysForBounds({ x: 0, y: 0, w: 2048 * 1000, h: 2048 * 1000 })).toThrow(/at most/);
  });

  it('still lists normal areas, up to the cap', () => {
    expect(tileKeysForBounds({ x: 0, y: 0, w: 4096, h: 2048 })).toEqual(['0:0', '1:0', '2:0', '0:1', '1:1', '2:1']);
    const side = Math.floor(Math.sqrt(MAX_TILES_PER_QUERY));
    expect(tileKeysForBounds({ x: 0, y: 0, w: (side - 1) * 2048, h: (side - 1) * 2048 })).toHaveLength(side * side);
  });
});

function nodeFor(result: ReturnType<typeof importClaudeWhiteboard>, elementId: string) {
  return result.graph.nodes.find((n) => (n.meta.import as { elementIds: string[] }).elementIds[0] === elementId)!;
}

describe('#64 Codex block 4: clipped merged text is reported and kept', () => {
  const long = (word: string) => `${`${word} `.repeat(500).trim()}`; // ~3000 chars

  it('keeps a long heading summary, gate summary, pill caption and image inner text in body and reports the clip', () => {
    const result = importClaudeWhiteboard(exportWith({
      h1: { type: 'text', size: 'large', text: 'Heading', x: 0, y: 0 },
      h1s: { type: 'text', size: 'body', text: long('heading'), x: 0, y: 50, wrap: 400 },
      g1: { type: 'text', size: 'large', text: '01 · Foundation', x: 2000, y: 0 },
      g1s: { type: 'text', size: 'body', text: long('gate'), x: 2000, y: 50, wrap: 400 },
      p1: { type: 'shape', text: 'Pill', x: 4000, y: 0, w: 120, h: 40 },
      p1s: { type: 'text', size: 'small', text: long('pill'), x: 4000, y: 50, wrap: 400 },
      i1: { type: 'image', src: '/_blob/a.png', x: 6000, y: 0, w: 800, h: 800 },
      i1t: { type: 'text', size: 'body', text: long('inner'), x: 6010, y: 10, wrap: 400 },
    }), { worldId: 'codex' });
    expect(validateWorldGraph(result.graph).ok).toBe(true);
    for (const [elementId, sourceId, word] of [['h1', 'h1s', 'heading'], ['g1', 'g1s', 'gate'], ['p1', 'p1s', 'pill'], ['i1', 'i1t', 'inner']] as const) {
      const node = nodeFor(result, elementId);
      expect(node.body, elementId).toContain(long(word));
      const entry = result.report.truncated.find((t) => t.nodeId === node.id && t.field === 'summary');
      expect(entry, elementId).toMatchObject({ fullTextIn: 'body', originalLength: long(word).length });
      expect(entry!.elementIds).toContain(sourceId);
    }
  });

  it('reports a clipped title and keeps the full title in body', () => {
    const title = long('caption');
    const result = importClaudeWhiteboard(exportWith({
      i1: { type: 'image', src: '/_blob/a.png', x: 0, y: 0, w: 200, h: 200 },
      c1: { type: 'text', size: 'small', text: title, x: 0, y: 210, wrap: 400 },
    }), { worldId: 'codex' });
    const image = result.graph.nodes.find((n) => n.kind === 'image')!;
    expect(image.title.length).toBeLessThanOrEqual(300);
    expect(image.body).toContain(title);
    expect(result.report.truncated.some((t) => t.nodeId === image.id && t.field === 'title')).toBe(true);
  });
});

describe('#64 Codex block 5: duplicate ids in array exports', () => {
  it('reports each duplicate, keeps every element, and resolves arrows to the first occurrence', () => {
    const result = importClaudeWhiteboard(exportWith([
      { id: 'a', type: 'text', size: 'body', text: 'First note with the id a.', x: 0, y: 0 },
      { id: 'b', type: 'text', size: 'body', text: 'Target note.', x: 0, y: 400 },
      { id: 'a', type: 'text', size: 'body', text: 'Second note that reuses a.', x: 0, y: 800 },
      { id: 'arrow', type: 'arrow', from: 'a', to: 'b' },
    ]), { worldId: 'codex' });
    expect(result.report.duplicateIds).toEqual([{ id: 'a', occurrences: 2, keys: ['a', 'a~2'] }]);
    expect(result.report.elementsIn).toBe(4);
    expect(Object.keys(result.elements).sort()).toEqual(['a', 'a~2', 'arrow', 'b'].sort());
    expect(result.elements['a~2']).toMatchObject({ as: 'node' });
    expect(result.graph.nodes.some((n) => n.title.startsWith('Second note'))).toBe(true);
    const first = result.elements.a as { nodeId: string };
    const edge = result.graph.edges.find((e) => e.relation === 'precedes')!;
    expect(edge.from).toBe(first.nodeId);
    expect(result.report.warnings.some((w) => w.includes('arrow') && w.includes('"a"'))).toBe(true);
    // Deterministic: same input, same output.
    const again = importClaudeWhiteboard(exportWith([
      { id: 'a', type: 'text', size: 'body', text: 'First note with the id a.', x: 0, y: 0 },
      { id: 'b', type: 'text', size: 'body', text: 'Target note.', x: 0, y: 400 },
      { id: 'a', type: 'text', size: 'body', text: 'Second note that reuses a.', x: 0, y: 800 },
      { id: 'arrow', type: 'arrow', from: 'a', to: 'b' },
    ]), { worldId: 'codex' });
    expect(JSON.stringify(again)).toBe(JSON.stringify(result));
  });
});

describe('#64 Codex block 6: CLI refuses overlapping paths', () => {
  async function setup() {
    const dir = await mkdtemp(join(tmpdir(), 'world-cli-'));
    const input = join(dir, 'board.json');
    const source = JSON.stringify(exportWith({ t1: { type: 'text', size: 'body', text: 'A note.', x: 0, y: 0 } }));
    await writeFile(input, source);
    const lexicon = join(dir, 'lexicon.json');
    await writeFile(lexicon, '{}');
    return { dir, input, source, lexicon };
  }
  const io = () => {
    const err: string[] = [];
    return { err, io: { stdout: () => undefined, stderr: (t: string) => err.push(t) } };
  };

  it('--out equal to --report exits non-zero and writes nothing', async () => {
    const { dir, input } = await setup();
    const out = join(dir, 'world.json');
    const { err, io: cli } = io();
    expect(await runImportWhiteboard(['--in', input, '--out', out, '--report', out], cli)).not.toBe(0);
    expect(err.join('')).toMatch(/--out and --report/);
    await expect(readFile(out, 'utf8')).rejects.toThrow();
  });

  it('refuses to overwrite the input or the lexicon', async () => {
    const { dir, input, source, lexicon } = await setup();
    expect(await runImportWhiteboard(['--in', input, '--out', input], io().io)).not.toBe(0);
    expect(await runImportWhiteboard(['--in', input, '--lexicon', lexicon, '--report', join(dir, '.', 'lexicon.json')], io().io)).not.toBe(0);
    expect(await readFile(input, 'utf8')).toBe(source);
    expect(await readFile(lexicon, 'utf8')).toBe('{}');
  });

  it('compares case-insensitively on win32', async () => {
    const { dir, input } = await setup();
    const { io: cli } = io();
    expect(await runImportWhiteboard(['--in', input, '--out', join(dir, 'W.json'), '--report', join(dir, 'w.json')], { ...cli, platform: 'win32' })).not.toBe(0);
  });

  it('still runs with distinct paths', async () => {
    const { dir, input } = await setup();
    expect(await runImportWhiteboard(['--in', input, '--out', join(dir, 'world.json'), '--report', join(dir, 'report.json')], io().io)).toBe(0);
    expect(JSON.parse(await readFile(join(dir, 'world.json'), 'utf8')).schemaVersion).toBe('starlight.worldGraph.v1');
  });
});

describe('#64 Codex block 7: media href allows only http(s) and relative/R2 keys', () => {
  const base = { role: 'reference' as const, r2Key: 'worlds/a.png' };
  it('rejects executable schemes and tricks', () => {
    for (const href of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<script>1</script>', 'vbscript:msgbox', 'java\tscript:alert(1)', ' javascript:alert(1)', '//evil.example/x', '/\\evil.example', 'file:///etc/passwd', 'mailto:a@b.c']) {
      expect(mediaSchema.safeParse({ ...base, href }).success, href).toBe(false);
    }
  });
  it('accepts http(s), relative paths and R2 keys', () => {
    for (const href of ['https://example.com/doc', 'http://example.com/x?y=1#z', '/worlds/arcanea/plate.png', 'worlds/arcanea/plate.png', 'plate.png#frame', '?page=2']) {
      expect(mediaSchema.safeParse({ ...base, href }).success, href).toBe(true);
    }
  });
});

describe('#64 non-blocking review items', () => {
  it('reads an offset-less timestamp as UTC regardless of the machine time zone', () => {
    const result = importClaudeWhiteboard(exportWith({ t1: { type: 'text', size: 'body', text: 'A note.', x: 0, y: 0 } }, { exportedAt: '2026-01-02T10:00:00' }), { worldId: 'codex' });
    expect(result.graph.world.updatedAt).toBe('2026-01-02T10:00:00.000Z');
    expect(() => importClaudeWhiteboard(exportWith({}, { exportedAt: 'Jan 2 2026' }), { worldId: 'codex' })).toThrow(/ISO 8601/);
    const offset = importClaudeWhiteboard(exportWith({}, { exportedAt: '2026-01-02T10:00:00+02:00' }), { worldId: 'codex' });
    expect(offset.graph.world.updatedAt).toBe('2026-01-02T08:00:00.000Z');
  });

  it('counts oversized images in needsReupload', () => {
    const result = importClaudeWhiteboard(exportWith({
      i1: { type: 'image', src: `data:image/png;base64,${'A'.repeat(120_000)}`, x: 0, y: 0, w: 200, h: 200 },
      i2: { type: 'image', src: '/_blob/b.png', x: 1000, y: 0, w: 200, h: 200 },
    }), { worldId: 'codex' });
    expect(result.report.needsReupload).toBe(2);
  });

  it('removes many nodes in one batch in linear time', () => {
    const graph = sampleGraph();
    const count = 3000;
    for (let i = 0; i < count; i++) {
      graph.nodes.push({ ...graph.nodes[0], id: `n_bulk_${i}`, title: `Bulk ${i}` });
      graph.edges.push({ ...graph.edges[0], id: `e_bulk_${i}`, from: `n_bulk_${i}`, to: 'n_b' });
    }
    const ops = Array.from({ length: 500 }, (_, i) => ({ op: 'removeNode', id: `n_bulk_${i}`, baseVersion: 1 }));
    const start = performance.now();
    const result = applyOps(graph, ops, ctx);
    const elapsed = performance.now() - start;
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed.removedEdges).toHaveLength(500);
    expect(result.graph.edges).toHaveLength(graph.edges.length - 500);
    expect(elapsed).toBeLessThan(1000);
  });
});
