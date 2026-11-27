import { describe, expect, it } from 'vitest';
import { regionAt, semanticZoomLevel, SEMANTIC_ZOOM_THRESHOLDS, tileKey, tileKeysForBounds, nodesInBounds } from '../zoom.js';
import { node, sampleGraph } from './helpers.js';

describe('semantic zoom', () => {
  it('maps zoom to cluster, card and full at the documented thresholds', () => {
    expect(SEMANTIC_ZOOM_THRESHOLDS).toEqual({ card: 0.4, full: 1.2 });
    expect(semanticZoomLevel(0.05)).toBe('cluster');
    expect(semanticZoomLevel(0.3999)).toBe('cluster');
    expect(semanticZoomLevel(0.4)).toBe('card');
    expect(semanticZoomLevel(1)).toBe('card');
    expect(semanticZoomLevel(1.1999)).toBe('card');
    expect(semanticZoomLevel(1.2)).toBe('full');
    expect(semanticZoomLevel(4)).toBe('full');
  });

  it('rejects zero, negative and non-finite zoom', () => {
    for (const zoom of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => semanticZoomLevel(zoom)).toThrow(RangeError);
    }
  });
});

describe('region loading helpers', () => {
  it('computes tile keys, including negative coordinates', () => {
    expect(tileKey({ x: 0, y: 0 })).toBe('0:0');
    expect(tileKey({ x: 2047, y: 2048 })).toBe('0:1');
    expect(tileKey({ x: -1, y: -2049 })).toBe('-1:-2');
    expect(tileKeysForBounds({ x: -10, y: 0, w: 2100, h: 10 })).toEqual(['-1:0', '0:0', '1:0']);
  });

  it('finds the smallest containing region and nodes in a viewport', () => {
    const regions = [
      ...sampleGraph().world.regions,
      { id: 'r_inner', title: 'Inner', bounds: { x: 100, y: 100, w: 50, h: 50 } },
    ];
    expect(regionAt(regions, { x: 120, y: 120 })?.id).toBe('r_inner');
    expect(regionAt(regions, { x: 1500, y: 10 })?.id).toBe('r_edge');
    expect(regionAt(regions, { x: 5000, y: 5000 })).toBeNull();

    const nodes = [node('a', { position: { x: 0, y: 0 }, size: { w: 10, h: 10 } }), node('b', { position: { x: 500, y: 500 } })];
    expect(nodesInBounds(nodes, { x: 5, y: 5, w: 100, h: 100 }).map((n) => n.id)).toEqual(['a']);
  });
});
