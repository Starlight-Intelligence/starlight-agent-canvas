import { describe, expect, it } from 'vitest';
import { importClaudeWhiteboard } from '../import/claude-whiteboard.js';
import { applyOps } from '../ops.js';
import { validateWorldGraph } from '../validate.js';
import { claude, sampleGraph } from './helpers.js';

const ctx = { actor: claude };

describe('applyOps: proposals match the final batch state (#64 review)', () => {
  it('drops a proposal when a later op in the batch edits the target', () => {
    const result = applyOps(sampleGraph(), [
      { op: 'proposeCanon', target: { type: 'node', id: 'n_a' }, baseVersion: 1 },
      { op: 'updateNode', id: 'n_a', baseVersion: 2, patch: { summary: 'changed after proposing' } },
    ], ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.graph.nodes.find((n) => n.id === 'n_a')!.canon.status).toBe('draft');
    expect(result.proposals).toEqual([]);
  });

  it('drops a proposal when a later op in the batch removes the target', () => {
    const result = applyOps(sampleGraph(), [
      { op: 'proposeCanon', target: { type: 'node', id: 'n_a' }, baseVersion: 1 },
      { op: 'removeNode', id: 'n_a', baseVersion: 2 },
    ], ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.proposals).toEqual([]);
  });

  it('keeps one proposal per target, at the final version', () => {
    const result = applyOps(sampleGraph(), [
      { op: 'proposeCanon', target: { type: 'node', id: 'n_a' }, baseVersion: 1, note: 'first' },
      { op: 'proposeCanon', target: { type: 'node', id: 'n_a' }, baseVersion: 2, note: 'second' },
      { op: 'moveNodes', moves: [{ id: 'n_a', baseVersion: 3, position: { x: 5, y: 5 } }] },
    ], ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]).toMatchObject({ id: 'n_a', note: 'second', version: 4 });
  });
});

describe('applyOps: undefined patch values (#64 review)', () => {
  it('rejects a patch whose only key is undefined', () => {
    const result = applyOps(sampleGraph(), [
      { op: 'updateNode', id: 'n_a', baseVersion: 1, patch: { title: undefined } },
    ], ctx);
    expect(result.ok).toBe(false);
  });

  it('ignores undefined keys next to real changes', () => {
    const result = applyOps(sampleGraph(), [
      { op: 'updateNode', id: 'n_a', baseVersion: 1, patch: { title: undefined, summary: 'kept' } },
    ], ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const updated = result.graph.nodes.find((n) => n.id === 'n_a')!;
    expect(updated).toMatchObject({ title: 'Alpha', summary: 'kept' });
    expect(validateWorldGraph(result.graph).ok).toBe(true);
  });
});

function exportWith(elements: Record<string, unknown>): unknown {
  return { title: 'Edge Cases', exportedAt: '2026-01-02', format: 'claude-whiteboard v1 elements', elements };
}

describe('importClaudeWhiteboard: edge cases (#64 review)', () => {
  it('keeps the full text of a long single-line note in body', () => {
    const text = `${'word '.repeat(600).trim()}.`;
    expect(text.length).toBeGreaterThan(2_000);
    expect(text.includes('\n')).toBe(false);
    const result = importClaudeWhiteboard(exportWith({
      t1: { type: 'text', size: 'body', color: '#f6f7f9', text, x: 0, y: 0, wrap: 300 },
    }), { worldId: 'edge' });
    const note = result.graph.nodes.find((n) => n.meta.import && (n.meta.import as { elementIds: string[] }).elementIds.includes('t1'))!;
    expect(note.body).toBe(text);
    expect(validateWorldGraph(result.graph).ok).toBe(true);
  });

  it('imports the rest of the world when an embedded image is over the originalSrc limit', () => {
    const src = `data:image/png;base64,${'A'.repeat(120_000)}`;
    const result = importClaudeWhiteboard(exportWith({
      i1: { type: 'image', src, x: 0, y: 0, w: 200, h: 200 },
      t1: { type: 'text', size: 'body', color: '#f6f7f9', text: 'A note that must survive.', x: 600, y: 600, wrap: 300 },
    }), { worldId: 'edge' });
    expect(validateWorldGraph(result.graph).ok).toBe(true);
    const image = result.graph.nodes.find((n) => n.kind === 'image')!;
    expect(image.media).toEqual([]);
    expect(image.meta).toMatchObject({ needsReupload: true, oversizedSrc: { length: src.length } });
    expect(result.graph.nodes.some((n) => n.title.startsWith('A note that must survive'))).toBe(true);
    expect(result.report.warnings.some((w) => w.includes('i1') && w.includes('limit'))).toBe(true);
  });
});
