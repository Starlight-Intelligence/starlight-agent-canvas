import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { importClaudeWhiteboard } from '../import/claude-whiteboard.js';
import { mediaSchema, worldNodeSchema } from '../schemas.js';
import { validateWorldGraph } from '../validate.js';
import { MAX_TILES_PER_QUERY, tileKeysForBounds } from '../zoom.js';
import { node } from './helpers.js';

// Findings from the starlight-signoff review of 2a2234d on #64.

const fixture = JSON.parse(readFileSync(new URL('./fixtures/whiteboard-sample.json', import.meta.url), 'utf8')) as {
  elements: Record<string, Record<string, unknown>>;
} & Record<string, unknown>;

function withElements(extra: Record<string, Record<string, unknown>>) {
  return { ...fixture, elements: { ...fixture.elements, ...extra } };
}

describe('tileKeysForBounds limits', () => {
  it('rejects rectangles that cover too many tiles', () => {
    expect(() => tileKeysForBounds({ x: 0, y: 0, w: 2048 * 100, h: 2048 * 100 })).toThrow(RangeError);
    const edge = Math.floor(Math.sqrt(MAX_TILES_PER_QUERY)) - 1;
    expect(tileKeysForBounds({ x: 0, y: 0, w: 2048 * edge, h: 2048 * edge })).toHaveLength((edge + 1) ** 2);
  });

  it('rejects tile indices outside the safe integer range', () => {
    expect(() => tileKeysForBounds({ x: 1e300, y: 0, w: 1, h: 1 })).toThrow(RangeError);
  });
});

describe('href and canon ref are http(s) only', () => {
  it('rejects executable URL schemes', () => {
    expect(mediaSchema.safeParse({ role: 'plate', r2Key: 'a.png', href: 'javascript:alert(1)' }).success).toBe(false);
    expect(mediaSchema.safeParse({ role: 'plate', r2Key: 'a.png', href: 'https://example.com/a' }).success).toBe(true);
    expect(worldNodeSchema.safeParse({ ...node('n_x'), canon: { status: 'proposed', ref: 'javascript:alert(1)' } }).success).toBe(false);
  });
});

describe('importer input checks', () => {
  it('rejects duplicate element ids in array input', () => {
    const input = {
      title: 'Dup',
      exportedAt: '2026-01-02',
      elements: [
        { id: 'a', type: 'text', size: 'body', text: 'one', x: 0, y: 0 },
        { id: 'a', type: 'text', size: 'body', text: 'two', x: 0, y: 100 },
      ],
    };
    expect(() => importClaudeWhiteboard(input)).toThrow(/duplicate element id "a"/);
  });

  it('rejects timestamps without a time zone and normalizes offsets to UTC', () => {
    expect(() => importClaudeWhiteboard(fixture, { at: '2026-01-02T10:00:00' })).toThrow(/Z or an offset/);
    const result = importClaudeWhiteboard(fixture, { at: '2026-01-02T10:00:00+02:00' });
    expect(result.graph.world.updatedAt).toBe('2026-01-02T08:00:00.000Z');
  });
});

describe('importer keeps long merged text', () => {
  it('keeps a long heading summary in body instead of clipping it away', () => {
    const long = `${'A long description. '.repeat(150)}End.`;
    expect(long.length).toBeGreaterThan(2000);
    const result = importClaudeWhiteboard(withElements({
      t3: { type: 'text', size: 'body', color: '#f6f7f9', text: long, x: 2000, y: 462, wrap: 300 },
    }), { worldId: 'testland' });
    const oren = result.graph.nodes.find((n) => n.title === 'Oren')!;
    expect(oren.summary.length).toBeLessThanOrEqual(2000);
    expect(oren.body).toBe(long);
    expect(validateWorldGraph(result.graph).ok).toBe(true);
  });

  it('keeps a long image caption in body', () => {
    const caption = 'Caption '.repeat(60).trim();
    expect(caption.length).toBeGreaterThan(300);
    const result = importClaudeWhiteboard(withElements({
      t15: { type: 'text', size: 'body', color: '#a9adb7', text: caption, x: 500, y: 2416 },
    }), { worldId: 'testland' });
    const image = result.graph.nodes.find((n) => n.meta.import && (n.meta.import as { elementIds: string[] }).elementIds.includes('t15'))!;
    expect(image.title.length).toBeLessThanOrEqual(300);
    expect(image.body).toBe(caption);
  });
});

describe('importer counts oversized images for re-upload', () => {
  it('includes an oversized embedded image in needsReupload', () => {
    const big = `data:image/png;base64,${'A'.repeat(100_100)}`;
    const result = importClaudeWhiteboard(withElements({
      i5: { type: 'image', src: big, x: 500, y: 2100, w: 400, h: 300 },
    }), { worldId: 'testland' });
    expect(result.report.needsReupload).toBe(5);
    expect(result.report.warnings.some((w) => w.includes('i5'))).toBe(true);
  });
});
