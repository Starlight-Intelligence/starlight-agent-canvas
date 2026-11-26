import type { Bounds, Position, Region, WorldNode } from './schemas.js';

/**
 * Semantic zoom. The level is a pure function of the viewport zoom factor
 * (1 = 100%, one world unit per screen pixel).
 *
 * - cluster: zoom < 0.4. Regions and cluster counts only; no node text.
 * - card:    0.4 <= zoom < 1.2. Node cards with title, kind, image thumbnail.
 * - full:    zoom >= 1.2. Full node content: summary, body, media.
 */
export const SEMANTIC_ZOOM_LEVELS = ['cluster', 'card', 'full'] as const;
export type SemanticZoomLevel = (typeof SEMANTIC_ZOOM_LEVELS)[number];

export const SEMANTIC_ZOOM_THRESHOLDS = Object.freeze({
  /** Lowest zoom that shows cards. */
  card: 0.4,
  /** Lowest zoom that shows full content. */
  full: 1.2,
});

export function semanticZoomLevel(zoom: number): SemanticZoomLevel {
  if (!Number.isFinite(zoom) || zoom <= 0) {
    throw new RangeError(`zoom must be a finite number > 0, got ${zoom}`);
  }
  if (zoom < SEMANTIC_ZOOM_THRESHOLDS.card) return 'cluster';
  if (zoom < SEMANTIC_ZOOM_THRESHOLDS.full) return 'card';
  return 'full';
}

/**
 * Spatial tiles for region loading. World space is cut into square tiles of
 * TILE_SIZE units; a node belongs to the tile containing its position. L2
 * indexes nodes by (worldId, tileKey) so a viewport query reads only the
 * tiles it overlaps.
 */
export const TILE_SIZE = 2048;

export function tileKey(position: Position, tileSize = TILE_SIZE): string {
  return `${Math.floor(position.x / tileSize)}:${Math.floor(position.y / tileSize)}`;
}

/**
 * Most tiles one tileKeysForBounds call will list. 4096 tiles of 2048 units
 * cover a 131k x 131k square, far more than any viewport or region needs.
 */
export const MAX_TILES_PER_QUERY = 4096;

/**
 * Tile keys overlapped by a rectangle, row-major.
 *
 * Throws RangeError for non-finite input, a non-positive tile size, more than
 * `maxTiles` tiles, or tile indices beyond Number.MAX_SAFE_INTEGER (where
 * `index + 1` no longer advances and the loop would never end).
 */
export function tileKeysForBounds(bounds: Bounds, tileSize = TILE_SIZE, maxTiles = MAX_TILES_PER_QUERY): string[] {
  if (!Number.isFinite(tileSize) || tileSize <= 0) throw new RangeError(`tileSize must be a finite number > 0, got ${tileSize}`);
  for (const [name, value] of Object.entries({ x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h })) {
    if (!Number.isFinite(value)) throw new RangeError(`bounds.${name} must be finite, got ${value}`);
  }
  if (bounds.w < 0 || bounds.h < 0) throw new RangeError('bounds.w and bounds.h must be >= 0.');
  const x0 = Math.floor(bounds.x / tileSize);
  const y0 = Math.floor(bounds.y / tileSize);
  const x1 = Math.floor((bounds.x + bounds.w) / tileSize);
  const y1 = Math.floor((bounds.y + bounds.h) / tileSize);
  for (const index of [x0, y0, x1, y1]) {
    if (!Number.isSafeInteger(index)) {
      throw new RangeError(`bounds reach tile index ${index}, beyond the safe integer range; query a smaller area.`);
    }
  }
  const count = (x1 - x0 + 1) * (y1 - y0 + 1);
  if (!Number.isSafeInteger(count) || count > maxTiles) {
    throw new RangeError(`bounds cover ${count} tiles; at most ${maxTiles} may be listed in one query.`);
  }
  const keys: string[] = [];
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) keys.push(`${tx}:${ty}`);
  }
  return keys;
}

export function boundsIntersect(a: Bounds, b: Bounds): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

export function nodeBounds(node: Pick<WorldNode, 'position' | 'size'>): Bounds {
  return { x: node.position.x, y: node.position.y, w: node.size?.w ?? 1, h: node.size?.h ?? 1 };
}

/** Nodes whose box overlaps the viewport rectangle. */
export function nodesInBounds<T extends Pick<WorldNode, 'position' | 'size'>>(nodes: readonly T[], viewport: Bounds): T[] {
  return nodes.filter((node) => boundsIntersect(nodeBounds(node), viewport));
}

/** The smallest region containing the point, or null. */
export function regionAt(regions: readonly Region[], point: Position): Region | null {
  let best: Region | null = null;
  for (const region of regions) {
    const b = region.bounds;
    const inside = point.x >= b.x && point.x <= b.x + b.w && point.y >= b.y && point.y <= b.y + b.h;
    if (inside && (!best || b.w * b.h < best.bounds.w * best.bounds.h)) best = region;
  }
  return best;
}
