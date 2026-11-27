import {
  boundsSchema,
  entityIdSchema,
  SEMANTIC_ZOOM_LEVELS,
  semanticZoomLevel,
  TILE_SIZE,
  tileKeysForBounds,
  WORLD_TOOL_LIMITS,
  type Bounds,
  type SemanticZoomLevel,
  type WorldEdge,
  type WorldNode,
} from '@starlight-agent-canvas/world';
import { z } from 'zod';

/** Upper bounds that keep one region read cheap at 100k+ nodes per world. */
export const REGION_LIMITS = {
  /** Tiles a single query may touch (32 x 32 tiles = 65k x 65k world units). */
  maxTiles: 1024,
  defaultNodes: 2000,
  maxNodes: WORLD_TOOL_LIMITS.regionMaxNodes,
  maxEdges: 20_000,
} as const;

export const regionQuerySchema = z.strictObject({
  regionId: entityIdSchema.optional(),
  bounds: boundsSchema.optional(),
  /** Semantic zoom level. Wins over `zoom` when both are set. */
  level: z.enum(SEMANTIC_ZOOM_LEVELS).optional(),
  /** Viewport zoom factor; mapped with semanticZoomLevel. */
  zoom: z.number().finite().positive().optional(),
  kinds: z.array(z.string().min(1).max(64)).max(32).optional(),
  limit: z.number().int().positive().max(REGION_LIMITS.maxNodes).optional(),
}).refine((q) => Boolean(q.regionId || q.bounds), { message: 'Pass regionId or bounds.' });
export type RegionQuery = z.infer<typeof regionQuerySchema>;

export function resolveLevel(query: Pick<RegionQuery, 'level' | 'zoom'>): SemanticZoomLevel {
  if (query.level) return query.level;
  if (query.zoom !== undefined) return semanticZoomLevel(query.zoom);
  return 'card';
}

/**
 * Tiles to read for a viewport. Nodes belong to the tile of their top-left
 * position, so a node that starts left of or above the viewport can still
 * overlap it. Padding one tile on those sides catches every node up to one
 * tile wide and tall; larger nodes come from a separate indexed path in
 * WorldStore.nodesInTiles.
 */
export function queryTiles(bounds: Bounds): string[] {
  return tileKeysForBounds({ x: bounds.x - TILE_SIZE, y: bounds.y - TILE_SIZE, w: bounds.w + TILE_SIZE, h: bounds.h + TILE_SIZE });
}

export function tileCountFor(bounds: Bounds): number {
  const x0 = Math.floor((bounds.x - TILE_SIZE) / TILE_SIZE);
  const y0 = Math.floor((bounds.y - TILE_SIZE) / TILE_SIZE);
  const x1 = Math.floor((bounds.x + bounds.w) / TILE_SIZE);
  const y1 = Math.floor((bounds.y + bounds.h) / TILE_SIZE);
  return (x1 - x0 + 1) * (y1 - y0 + 1);
}

/** Card-level node: what a card shows. No body, no full media list. */
export interface NodeCard {
  id: string;
  kind: WorldNode['kind'];
  title: string;
  tags: string[];
  position: WorldNode['position'];
  size?: WorldNode['size'];
  regionId: string | null;
  layer: number;
  canon: WorldNode['canon'];
  version: number;
  thumbnail?: WorldNode['media'][number];
}

export function toCard(node: WorldNode): NodeCard {
  const thumbnail = node.media.find((m) => m.role === 'cover' || m.role === 'portrait' || m.role === 'plate') ?? node.media[0];
  return {
    id: node.id,
    kind: node.kind,
    title: node.title,
    tags: node.tags,
    position: node.position,
    ...(node.size ? { size: node.size } : {}),
    regionId: node.regionId,
    layer: node.layer,
    canon: node.canon,
    version: node.version,
    ...(thumbnail ? { thumbnail } : {}),
  };
}

export interface ClusterSummary {
  tile: string;
  count: number;
  byKind: Record<string, number>;
  /** Mean node position in the tile: where to draw the cluster bubble. */
  center: { x: number; y: number };
}

export function summarizeClusters(rows: readonly { tile: string; kind: string; count: number; x: number; y: number }[]): ClusterSummary[] {
  const byTile = new Map<string, { count: number; byKind: Record<string, number>; sx: number; sy: number }>();
  for (const row of rows) {
    const entry = byTile.get(row.tile) ?? { count: 0, byKind: {}, sx: 0, sy: 0 };
    entry.count += row.count;
    entry.byKind[row.kind] = (entry.byKind[row.kind] ?? 0) + row.count;
    entry.sx += row.x * row.count;
    entry.sy += row.y * row.count;
    byTile.set(row.tile, entry);
  }
  return [...byTile.entries()]
    .map(([tile, e]) => ({ tile, count: e.count, byKind: e.byKind, center: { x: e.sx / e.count, y: e.sy / e.count } }))
    .sort((a, b) => a.tile.localeCompare(b.tile));
}

export type EdgeSummary = Pick<WorldEdge, 'id' | 'from' | 'to' | 'relation' | 'label' | 'canon' | 'version'>;

export function projectEdges(edges: readonly WorldEdge[], level: SemanticZoomLevel): (WorldEdge | EdgeSummary)[] {
  if (level === 'full') return [...edges];
  return edges.map((e) => ({ id: e.id, from: e.from, to: e.to, relation: e.relation, ...(e.label ? { label: e.label } : {}), canon: e.canon, version: e.version }));
}
