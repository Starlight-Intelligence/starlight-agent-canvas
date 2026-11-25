import type { NodeKind, WorldEdge, WorldNode } from '@starlight-agent-canvas/world';

/** Kinds that sit on the timeline even without a precedes or follows edge. */
export const TIMELINE_KINDS: ReadonlySet<NodeKind> = new Set<NodeKind>(['story', 'book', 'chapter', 'scene', 'event', 'gate']);

const LANES: Partial<Record<NodeKind, number>> = { story: 0, book: 0, chapter: 1, scene: 1, event: 2, gate: 3 };
export const TIMELINE_LANE_TITLES = ['Stories and books', 'Chapters and scenes', 'Events', 'Gates', 'Other'];

export function timelineNodes(nodes: readonly WorldNode[], edges: readonly WorldEdge[]): WorldNode[] {
  const sequenced = new Set<string>();
  for (const e of edges) {
    if (e.relation === 'precedes' || e.relation === 'follows') {
      sequenced.add(e.from);
      sequenced.add(e.to);
    }
  }
  return nodes.filter((n) => TIMELINE_KINDS.has(n.kind) || sequenced.has(n.id));
}

/**
 * Order by precedes and follows (Kahn), ties broken by authored position so the
 * whiteboard's left to right reading order is kept. Cycles fall back to position.
 */
export function timelineOrder(nodes: readonly WorldNode[], edges: readonly WorldEdge[]): WorldNode[] {
  const byPos = [...nodes].sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x);
  const rank = new Map(byPos.map((n, i) => [n.id, i]));
  const ids = new Set(nodes.map((n) => n.id));
  const next = new Map<string, string[]>();
  const indeg = new Map<string, number>(nodes.map((n) => [n.id, 0]));
  for (const e of edges) {
    let a: string;
    let b: string;
    if (e.relation === 'precedes') [a, b] = [e.from, e.to];
    else if (e.relation === 'follows') [a, b] = [e.to, e.from];
    else continue;
    if (!ids.has(a) || !ids.has(b)) continue;
    next.set(a, [...(next.get(a) ?? []), b]);
    indeg.set(b, (indeg.get(b) ?? 0) + 1);
  }
  // Min-heap on positional rank: O((n + e) log n), so 100k-node worlds stay responsive.
  const ready = new RankHeap();
  for (const n of byPos) if (indeg.get(n.id) === 0) ready.push(n.id, rank.get(n.id) ?? 0);
  const out: string[] = [];
  while (ready.size) {
    const id = ready.pop();
    out.push(id);
    for (const b of next.get(id) ?? []) {
      const d = (indeg.get(b) ?? 0) - 1;
      indeg.set(b, d);
      if (d === 0) ready.push(b, rank.get(b) ?? 0);
    }
  }
  const placed = new Set(out);
  for (const n of byPos) if (!placed.has(n.id)) out.push(n.id);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return out.map((id) => byId.get(id)!);
}

export interface LaidOut {
  id: string;
  x: number;
  y: number;
}

export const TIMELINE_STEP = 300;
export const TIMELINE_LANE_HEIGHT = 220;

/** Lanes by kind, columns by order. Each node gets its own column so arrows read left to right. */
export function timelineLayout(nodes: readonly WorldNode[], edges: readonly WorldEdge[]): LaidOut[] {
  return timelineOrder(nodes, edges).map((n, i) => ({
    id: n.id,
    x: i * TIMELINE_STEP,
    y: (LANES[n.kind] ?? 4) * TIMELINE_LANE_HEIGHT,
  }));
}

/** Rings by hop distance around the focused node. */
export function neighborhoodLayout(centerId: string, nodes: readonly WorldNode[], edges: readonly WorldEdge[], ringGap = 380): LaidOut[] {
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    adj.set(e.from, [...(adj.get(e.from) ?? []), e.to]);
    adj.set(e.to, [...(adj.get(e.to) ?? []), e.from]);
  }
  const depth = new Map<string, number>([[centerId, 0]]);
  const queue = [centerId];
  while (queue.length) {
    const id = queue.shift()!;
    for (const other of adj.get(id) ?? []) {
      if (!depth.has(other)) {
        depth.set(other, (depth.get(id) ?? 0) + 1);
        queue.push(other);
      }
    }
  }
  const rings = new Map<number, WorldNode[]>();
  for (const n of nodes) {
    const d = depth.get(n.id) ?? 1;
    rings.set(d, [...(rings.get(d) ?? []), n]);
  }
  const out: LaidOut[] = [];
  for (const [d, ring] of rings) {
    ring.sort((a, b) => a.kind.localeCompare(b.kind) || a.title.localeCompare(b.title));
    ring.forEach((n, i) => {
      if (d === 0) {
        out.push({ id: n.id, x: 0, y: 0 });
        return;
      }
      const angle = (i / ring.length) * Math.PI * 2 - Math.PI / 2;
      const r = d * ringGap + (ring.length > 24 ? (i % 2) * 120 : 0);
      out.push({ id: n.id, x: Math.round(Math.cos(angle) * r), y: Math.round(Math.sin(angle) * r) });
    });
  }
  return out;
}

/**
 * Keyboard navigation: the nearest node in a direction from the current one.
 * Candidates must lie within a 45 degree cone; distance is weighted to prefer
 * nodes straight ahead.
 */
export function nearestInDirection(
  from: { x: number; y: number },
  candidates: readonly { id: string; x: number; y: number }[],
  direction: 'left' | 'right' | 'up' | 'down',
): string | null {
  let best: string | null = null;
  let bestScore = Infinity;
  for (const c of candidates) {
    const dx = c.x - from.x;
    const dy = c.y - from.y;
    if (dx === 0 && dy === 0) continue;
    const along = direction === 'left' ? -dx : direction === 'right' ? dx : direction === 'up' ? -dy : dy;
    const across = direction === 'left' || direction === 'right' ? Math.abs(dy) : Math.abs(dx);
    if (along <= 0 || across > along) continue;
    const score = along + across * 2;
    if (score < bestScore) {
      bestScore = score;
      best = c.id;
    }
  }
  return best;
}

class RankHeap {
  private ids: string[] = [];
  private ranks: number[] = [];

  get size(): number {
    return this.ids.length;
  }

  push(id: string, rank: number): void {
    this.ids.push(id);
    this.ranks.push(rank);
    let i = this.ids.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.ranks[parent] <= this.ranks[i]) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  pop(): string {
    const top = this.ids[0];
    const lastId = this.ids.pop()!;
    const lastRank = this.ranks.pop()!;
    if (this.ids.length) {
      this.ids[0] = lastId;
      this.ranks[0] = lastRank;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < this.ranks.length && this.ranks[l] < this.ranks[m]) m = l;
        if (r < this.ranks.length && this.ranks[r] < this.ranks[m]) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return top;
  }

  private swap(a: number, b: number): void {
    [this.ids[a], this.ids[b]] = [this.ids[b], this.ids[a]];
    [this.ranks[a], this.ranks[b]] = [this.ranks[b], this.ranks[a]];
  }
}
