import type { Bounds, WorldEdge, WorldNode } from '@starlight-agent-canvas/world';

export const LAYOUT_STRATEGIES = ['grid', 'layered', 'force'] as const;
export type LayoutStrategy = (typeof LAYOUT_STRATEGIES)[number];

export interface Move {
  id: string;
  baseVersion: number;
  position: { x: number; y: number };
}

const CELL_W = 320;
const CELL_H = 200;
const PAD = 48;

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Deterministic layouts inside a region's bounds. Every position lands
 * inside the bounds, so get_region(regionId) still returns every laid-out node. Output is a list of moves
 * with the node's current version as baseVersion, ready for a moveNodes op.
 * Nodes that would not move are left out.
 */
export function layoutNodes(
  nodes: readonly WorldNode[],
  edges: readonly WorldEdge[],
  bounds: Bounds,
  strategy: LayoutStrategy,
): Move[] {
  const sorted = [...nodes].sort((a, b) => a.id.localeCompare(b.id));
  if (sorted.length === 0) return [];
  let positions: Map<string, { x: number; y: number }>;
  if (strategy === 'grid') positions = grid(sorted, bounds);
  else if (strategy === 'layered') positions = layered(sorted, edges, bounds);
  else positions = force(sorted, edges, bounds);

  const moves: Move[] = [];
  for (const node of sorted) {
    const p = positions.get(node.id)!;
    const position = { x: round(p.x), y: round(p.y) };
    if (position.x === node.position.x && position.y === node.position.y) continue;
    moves.push({ id: node.id, baseVersion: node.version, position });
  }
  return moves;
}

/** Inner box with padding that still leaves room when the region is small. */
function innerBox(bounds: Bounds): { x: number; y: number; w: number; h: number } {
  const pad = Math.min(PAD, bounds.w / 4, bounds.h / 4);
  return { x: bounds.x + pad, y: bounds.y + pad, w: Math.max(0, bounds.w - 2 * pad), h: Math.max(0, bounds.h - 2 * pad) };
}

/**
 * Step between cells: the preferred spacing, shrunk so `count` cells span at
 * most `span`. Positions are top-left corners, so the last cell starts at
 * (count - 1) * step, which stays inside the box.
 */
function step(preferred: number, span: number, count: number): number {
  return count <= 1 ? 0 : Math.min(preferred, span / (count - 1));
}

/** Grid sized to the region's aspect ratio; every position stays inside the bounds. */
function grid(nodes: readonly WorldNode[], bounds: Bounds): Map<string, { x: number; y: number }> {
  const box = innerBox(bounds);
  const n = nodes.length;
  const fitCols = Math.max(1, Math.floor(box.w / CELL_W) + 1);
  const aspectCols = Math.max(1, Math.ceil(Math.sqrt((n * Math.max(box.w, 1)) / Math.max(box.h, 1) * (CELL_H / CELL_W))));
  const cols = Math.min(n, Math.max(fitCols, aspectCols));
  const rows = Math.ceil(n / cols);
  const dx = step(CELL_W, box.w, cols);
  const dy = step(CELL_H, box.h, rows);
  const out = new Map<string, { x: number; y: number }>();
  nodes.forEach((node, i) => {
    out.set(node.id, { x: box.x + (i % cols) * dx, y: box.y + Math.floor(i / cols) * dy });
  });
  return out;
}

/** Longest-path layering over edges inside the set; columns left to right. */
function layered(nodes: readonly WorldNode[], edges: readonly WorldEdge[], bounds: Bounds): Map<string, { x: number; y: number }> {
  const ids = new Set(nodes.map((n) => n.id));
  const inner = edges.filter((e) => ids.has(e.from) && ids.has(e.to));
  const layer = new Map<string, number>(nodes.map((n) => [n.id, 0]));
  // Bellman-Ford style relaxation, capped at |V| rounds so cycles terminate.
  for (let round = 0; round < nodes.length; round++) {
    let changed = false;
    for (const e of inner) {
      const next = layer.get(e.from)! + 1;
      if (next > layer.get(e.to)! && next < nodes.length) {
        layer.set(e.to, next);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const rowOf = new Map<string, number>();
  const rows = new Map<number, number>();
  for (const node of nodes) {
    const l = layer.get(node.id)!;
    const r = rows.get(l) ?? 0;
    rows.set(l, r + 1);
    rowOf.set(node.id, r);
  }
  // Fit columns (layers) and rows into the region instead of overflowing it.
  const box = innerBox(bounds);
  const dx = step(CELL_W, box.w, Math.max(...layer.values()) + 1);
  const dy = step(CELL_H, box.h, Math.max(...rows.values()));
  const out = new Map<string, { x: number; y: number }>();
  for (const node of nodes) {
    out.set(node.id, { x: box.x + layer.get(node.id)! * dx, y: box.y + rowOf.get(node.id)! * dy });
  }
  return out;
}

/**
 * Small deterministic force layout (Fruchterman-Reingold), seeded from a grid.
 * Meant for one region of up to a few hundred nodes, not a whole world.
 */
function force(nodes: readonly WorldNode[], edges: readonly WorldEdge[], bounds: Bounds): Map<string, { x: number; y: number }> {
  const pos = grid(nodes, bounds);
  const box = innerBox(bounds);
  const ids = nodes.map((n) => n.id);
  const index = new Map(ids.map((id, i) => [id, i]));
  const xs = ids.map((id) => pos.get(id)!.x);
  const ys = ids.map((id) => pos.get(id)!.y);
  const inner = edges.filter((e) => index.has(e.from) && index.has(e.to));
  const area = bounds.w * bounds.h;
  const k = Math.sqrt(area / Math.max(1, nodes.length));
  const iterations = nodes.length > 300 ? 20 : 60;
  let temperature = Math.min(bounds.w, bounds.h) / 10;
  for (let it = 0; it < iterations; it++) {
    const dx = new Array<number>(ids.length).fill(0);
    const dy = new Array<number>(ids.length).fill(0);
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        let ddx = xs[i]! - xs[j]!;
        let ddy = ys[i]! - ys[j]!;
        let dist = Math.hypot(ddx, ddy);
        if (dist < 0.01) { ddx = 0.01 * (i - j); ddy = 0.01; dist = Math.hypot(ddx, ddy); }
        const f = (k * k) / dist;
        dx[i]! += (ddx / dist) * f; dy[i]! += (ddy / dist) * f;
        dx[j]! -= (ddx / dist) * f; dy[j]! -= (ddy / dist) * f;
      }
    }
    for (const e of inner) {
      const a = index.get(e.from)!;
      const b = index.get(e.to)!;
      const ddx = xs[a]! - xs[b]!;
      const ddy = ys[a]! - ys[b]!;
      const dist = Math.max(0.01, Math.hypot(ddx, ddy));
      const f = (dist * dist) / k;
      dx[a]! -= (ddx / dist) * f; dy[a]! -= (ddy / dist) * f;
      dx[b]! += (ddx / dist) * f; dy[b]! += (ddy / dist) * f;
    }
    for (let i = 0; i < ids.length; i++) {
      const len = Math.max(0.01, Math.hypot(dx[i]!, dy[i]!));
      xs[i] = Math.min(box.x + box.w, Math.max(box.x, xs[i]! + (dx[i]! / len) * Math.min(len, temperature)));
      ys[i] = Math.min(box.y + box.h, Math.max(box.y, ys[i]! + (dy[i]! / len) * Math.min(len, temperature)));
    }
    temperature *= 0.92;
  }
  return new Map(ids.map((id, i) => [id, { x: xs[i]!, y: ys[i]! }]));
}
