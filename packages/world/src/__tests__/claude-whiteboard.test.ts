import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { importClaudeWhiteboard } from '../import/claude-whiteboard.js';
import { validateWorldGraph } from '../validate.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/whiteboard-sample.json', import.meta.url), 'utf8')) as unknown;

function titles(result: ReturnType<typeof importClaudeWhiteboard>, kind: string): string[] {
  return result.graph.nodes.filter((n) => n.kind === kind).map((n) => n.title).sort();
}

function hasEdge(result: ReturnType<typeof importClaudeWhiteboard>, from: string, relation: string, to: string): boolean {
  const byTitle = new Map(result.graph.nodes.map((n) => [n.id, n.title]));
  return result.graph.edges.some((e) => byTitle.get(e.from) === from && e.relation === relation && byTitle.get(e.to) === to);
}

describe('importClaudeWhiteboard (synthetic fixture)', () => {
  const result = importClaudeWhiteboard(fixture, { worldId: 'testland' });

  it('accounts for every element and reports counts', () => {
    const { report } = result;
    expect(report.elementsIn).toBe(34);
    expect(report.elementsByType).toEqual({ arrow: 3, image: 5, shape: 5, text: 21 });
    expect(Object.keys(result.elements)).toHaveLength(34);
    expect(Object.values(report.dispositions).reduce((a, b) => a + b, 0)).toBe(34);
    expect(report.dispositions).toEqual({ node: 13, merged: 7, expanded: 5, edge: 2, region: 4, skipped: 3 });
    expect(report.regionsOut).toBe(5);
    expect(report.nodesOut).toBe(27);
    expect(report.edgesOut).toBe(21);
    expect(report.needsReupload).toBe(5);
    expect(report.skipped.map((s) => s.elementId).sort()).toEqual(['a3', 'b1', 's1']);
    expect(report.warnings).toEqual(['Gate "Crown" (t11) lists a god but no godbeast.']);
  });

  it('produces a valid, all-draft graph', () => {
    expect(validateWorldGraph(result.graph).ok).toBe(true);
    expect(result.graph.world).toMatchObject({ id: 'testland', title: 'Testland Atlas', version: 1, updatedAt: '2026-01-02T00:00:00.000Z' });
    expect(result.graph.nodes.every((n) => n.canon.status === 'draft')).toBe(true);
    expect(result.graph.edges.every((e) => e.canon.status === 'draft')).toBe(true);
    expect(result.graph.nodes.every((n) => n.createdBy.harness === 'importer')).toBe(true);
  });

  it('turns sections into regions and region nodes', () => {
    expect(result.graph.world.regions.map((r) => r.title)).toEqual(['Overview', 'The Core', 'The Story', 'The Gates', 'The Archive']);
    expect(titles(result, 'region')).toEqual(['The Archive', 'The Core', 'The Gates', 'The Story']);
    expect(hasEdge(result, 'The Gates', 'part-of', 'Testland Atlas')).toBe(true);
    const oren = result.graph.nodes.find((n) => n.title === 'Oren')!;
    expect(result.graph.world.regions.find((r) => r.id === oren.regionId)?.title).toBe('The Story');
  });

  it('infers gates, gods, godbeasts and their links', () => {
    expect(titles(result, 'gate')).toEqual(['Crown Gate', 'Stone Gate', 'Tide Gate']);
    expect(titles(result, 'god')).toEqual(['Bram', 'Mira', 'Solace']);
    expect(titles(result, 'godbeast')).toEqual(['Fen', 'Tusk']);
    expect(hasEdge(result, 'Bram', 'rules', 'Stone Gate')).toBe(true);
    expect(hasEdge(result, 'Bram', 'bonded-to', 'Tusk')).toBe(true);
    expect(hasEdge(result, 'Stone Gate', 'part-of', 'Three Gates')).toBe(true);
    const stone = result.graph.nodes.find((n) => n.title === 'Stone Gate')!;
    expect(stone.summary).toBe('Weight and patience.');
    expect(stone.tags).toEqual(['gate', 'gate-01']);
    // One "Bram × Tusk" element expands into two nodes; `part` disambiguates them.
    const provenance = (title: string) => result.graph.nodes.find((n) => n.title === title)!.meta.import;
    expect(provenance('Bram')).toEqual({ source: 'claude-whiteboard', elementIds: ['t5'], part: 'god' });
    expect(provenance('Tusk')).toEqual({ source: 'claude-whiteboard', elementIds: ['t5'], part: 'godbeast' });
    expect(provenance('House Brook')).toEqual({ source: 'claude-whiteboard', elementIds: ['t16'], part: '1' });
    expect(provenance('Stone Gate')).toEqual({ source: 'claude-whiteboard', elementIds: ['t4', 't6'] });
  });

  it('expands house lists, headings, bullets and free text', () => {
    expect(titles(result, 'house')).toEqual(['House Ash', 'House Brook']);
    expect(hasEdge(result, 'House Ash', 'part-of', 'Two Houses')).toBe(true);
    const oren = result.graph.nodes.find((n) => n.title === 'Oren')!;
    expect(oren.kind).toBe('character');
    expect(oren.summary).toBe('A careful mapmaker. Owes a debt to Bram.');
    expect(hasEdge(result, 'Oren', 'references', 'Bram')).toBe(true);
    expect(hasEdge(result, 'Some free note about Oren.', 'references', 'Oren')).toBe(true);
    expect(titles(result, 'concept')).toEqual(['First Book', 'Root & Branch', 'Second Book', 'Three Gates', 'Two Houses']);
    expect(hasEdge(result, 'Root & Branch', 'precedes', 'Three Gates')).toBe(true);
    expect(result.graph.nodes.find((n) => n.kind === 'world')?.summary).toBe('A world of tests.');
  });

  it('keeps image sources for re-upload and links depictions', () => {
    const images = result.graph.nodes.filter((n) => n.kind === 'image');
    expect(images).toHaveLength(5);
    for (const image of images) {
      expect(image.media).toHaveLength(1);
      expect(image.media[0].needsReupload).toBe(true);
      expect(image.media[0].originalSrc).toBeTruthy();
    }
    const placeholder = images.find((n) => n.media[0].role === 'placeholder')!;
    expect(placeholder.summary).toBe('Sealed. Redesign pending.');
    expect(placeholder.meta.generatedBy).toBe('claude');
    expect(images.find((n) => n.title === 'Archive · plates')).toBeTruthy();
    expect(images.find((n) => n.media[0].role === 'cover')?.media[0].href).toBe('https://example.com/cover');
    expect(hasEdge(result, 'Oren plate', 'references', 'Oren')).toBe(true);
    expect(hasEdge(result, 'Tide Gate placeholder', 'references', 'Tide Gate')).toBe(true);
  });

  it('applies lexicon kinds and tags', () => {
    const withLexicon = importClaudeWhiteboard(fixture, {
      worldId: 'testland',
      lexicon: { kinds: { 'first book': 'book', 'Second Book': 'book' }, tags: { Oren: ['lead'] } },
    });
    expect(titles(withLexicon, 'book')).toEqual(['First Book', 'Second Book']);
    expect(withLexicon.graph.nodes.find((n) => n.title === 'Oren')?.tags).toEqual(['lead']);
  });

  it('is deterministic', () => {
    const again = importClaudeWhiteboard(JSON.parse(JSON.stringify(fixture)), { worldId: 'testland' });
    expect(JSON.stringify(again.graph)).toBe(JSON.stringify(result.graph));
  });

  it('requires a timestamp when the export has none', () => {
    const { exportedAt: _drop, ...rest } = fixture as Record<string, unknown>;
    expect(() => importClaudeWhiteboard(rest)).toThrow(/options\.at/);
    expect(importClaudeWhiteboard(rest, { at: '2026-03-04T05:06:07.000Z' }).graph.world.updatedAt).toBe('2026-03-04T05:06:07.000Z');
  });
});

// The real export lives in a private repo. Point WORLD_WHITEBOARD_PATH at it to run this.
const realPath = process.env.WORLD_WHITEBOARD_PATH;
describe.skipIf(!realPath || !existsSync(realPath))('importClaudeWhiteboard (real export via WORLD_WHITEBOARD_PATH)', () => {
  it('imports all 123 elements', () => {
    const input = JSON.parse(readFileSync(realPath!, 'utf8')) as unknown;
    const { graph, report, elements } = importClaudeWhiteboard(input, { worldId: 'arcanea' });
    expect(report.elementsIn).toBe(123);
    expect(report.elementsByType).toEqual({ arrow: 7, image: 26, shape: 12, text: 78 });
    expect(Object.keys(elements)).toHaveLength(123);
    expect(Object.values(report.dispositions).reduce((a, b) => a + b, 0)).toBe(123);
    expect(report.needsReupload).toBe(26);
    expect(report.regionsOut).toBe(6);
    expect(report.nodesByKind.gate).toBe(10);
    expect(report.nodesByKind.god).toBe(10);
    expect(report.nodesByKind.godbeast).toBe(9);
    expect(report.nodesByKind.house).toBe(7);
    expect(report.nodesByKind.character).toBe(5);
    expect(report.nodesByKind.image).toBe(26);
    expect(report.edgesByRelation.precedes).toBe(7);
    expect(graph.nodes.every((n) => n.canon.status === 'draft')).toBe(true);
    expect(validateWorldGraph(graph).ok).toBe(true);
    // eslint-disable-next-line no-console
    console.log(`real export: ${report.elementsIn} elements -> ${report.nodesOut} nodes, ${report.edgesOut} edges, ${report.regionsOut} regions`);
  });
});
