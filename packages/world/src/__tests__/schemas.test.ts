import { describe, expect, it } from 'vitest';
import {
  ENTITY_ID_PATTERN,
  mediaSchema,
  NODE_KINDS,
  RELATIONS,
  worldEdgeSchema,
  worldGraphSchema,
  worldNodeSchema,
} from '../schemas.js';
import { findGraphIssues, parseWorldGraph, validateWorldGraph, WorldGraphValidationError } from '../validate.js';
import { newId, stableId } from '../ids.js';
import { node, sampleGraph } from './helpers.js';

describe('World Graph v1 schema', () => {
  it('round-trips a graph through JSON without loss', () => {
    const graph = sampleGraph();
    const once = worldGraphSchema.parse(graph);
    const twice = worldGraphSchema.parse(JSON.parse(JSON.stringify(once)));
    expect(twice).toEqual(once);
    expect(once).toEqual(graph);
  });

  it('fills defaults for a minimal node', () => {
    const parsed = worldNodeSchema.parse({
      id: 'n_min',
      worldId: 'testland',
      kind: 'note',
      title: 'Minimal',
      position: { x: 1, y: 2 },
      createdBy: { harness: 'human', at: '2026-01-01T00:00:00.000Z' },
      updatedAt: '2026-01-01T00:00:00.000Z',
      version: 1,
    });
    expect(parsed).toMatchObject({ summary: '', body: '', tags: [], media: [], regionId: null, layer: 0, meta: {}, canon: { status: 'draft' } });
  });

  it('exposes the agreed kinds and relations', () => {
    expect(NODE_KINDS).toHaveLength(18);
    expect(NODE_KINDS).toContain('godbeast');
    expect(RELATIONS).toHaveLength(11);
    expect(RELATIONS).toContain('bonded-to');
  });

  it('requires canon.ref when status is canon', () => {
    const bad = { ...node('n_x'), canon: { status: 'canon' } };
    expect(worldNodeSchema.safeParse(bad).success).toBe(false);
    const good = { ...node('n_x'), canon: { status: 'canon', ref: 'https://github.com/example/canon/pull/9' } };
    expect(worldNodeSchema.safeParse(good).success).toBe(true);
  });

  it('rejects unknown kinds, bad ids and bad harness slugs', () => {
    expect(worldNodeSchema.safeParse({ ...node('n_x'), kind: 'spaceship' }).success).toBe(false);
    expect(worldNodeSchema.safeParse({ ...node('n_x'), id: '../etc' }).success).toBe(false);
    expect(worldNodeSchema.safeParse({ ...node('n_x'), createdBy: { harness: 'Claude Code', at: '2026-01-01T00:00:00.000Z' } }).success).toBe(false);
  });

  it('requires media to point somewhere', () => {
    expect(mediaSchema.safeParse({ role: 'plate', alt: 'x' }).success).toBe(false);
    expect(mediaSchema.safeParse({ role: 'plate', r2Key: 'worlds/testland/a.png' }).success).toBe(true);
    expect(mediaSchema.safeParse({ role: 'plate', url: 'https://example.com/a.png' }).success).toBe(true);
    expect(mediaSchema.safeParse({ role: 'plate', url: 'javascript:alert(1)' }).success).toBe(false);
    expect(mediaSchema.safeParse({ role: 'plate', originalSrc: '/_blob/abc' }).success).toBe(false);
    expect(mediaSchema.safeParse({ role: 'plate', originalSrc: '/_blob/abc', needsReupload: true }).success).toBe(true);
  });

  it('rejects self-loop edges', () => {
    const edge = sampleGraph().edges[0];
    expect(worldEdgeSchema.safeParse({ ...edge, to: edge.from }).success).toBe(false);
  });
});

describe('validateWorldGraph', () => {
  it('accepts the sample graph', () => {
    const result = validateWorldGraph(sampleGraph());
    expect(result.ok).toBe(true);
  });

  it('reports dangling edges, duplicate ids, missing regions and world mismatches', () => {
    const graph = sampleGraph();
    graph.nodes.push(node('n_a'));
    graph.nodes.push(node('n_lost', { regionId: 'r_nowhere' }));
    graph.nodes.push(node('n_foreign', { worldId: 'elsewhere' }));
    graph.edges.push({ ...graph.edges[0], id: 'e_dangling', to: 'n_missing' });
    const codes = findGraphIssues(graph).map((issue) => issue.code).sort();
    expect(codes).toEqual(['DANGLING_EDGE', 'DUPLICATE_ID', 'MISSING_REGION', 'WORLD_MISMATCH']);
    expect(() => parseWorldGraph(graph)).toThrow(WorldGraphValidationError);
  });

  it('returns schema issues instead of throwing', () => {
    const result = validateWorldGraph({ schemaVersion: 'nope' });
    expect(result.ok).toBe(false);
    expect(result.issues.every((issue) => issue.code === 'SCHEMA')).toBe(true);
  });
});

describe('ids', () => {
  it('stableId is deterministic and keyed only by prefix and key', () => {
    expect(stableId('n', 'world\u0000e26', 'Hero')).toBe(stableId('n', 'world\u0000e26', 'Hero'));
    expect(stableId('n', 'world\u0000e26')).not.toBe(stableId('n', 'world\u0000e27'));
    expect(stableId('n', 'k')).not.toBe(stableId('e', 'k'));
    expect(stableId('n', 'k', 'Mera Tide-crest!')).toMatch(/^n_mera-tide-crest_[0-9a-z]{11}$/);
  });

  it('newId produces valid unique ids', () => {
    const a = newId('n', 'Some Title');
    const b = newId('n', 'Some Title');
    expect(a).not.toBe(b);
    expect(a).toMatch(ENTITY_ID_PATTERN);
    expect(newId('e')).toMatch(/^e_[0-9a-f]{16}$/);
  });
});
