import { TILE_SIZE, tileKey } from '@starlight-agent-canvas/world';
import type { Bounds, WorldEdge, WorldGraph, WorldNode } from '@starlight-agent-canvas/world';

/**
 * In-memory spatial index over a world graph: tile key to node ids, node id to
 * incident edge ids. Rebuilt in O(nodes + edges) after each accepted batch,
 * which is a few milliseconds at 10k nodes.
 */
export class TileIndex {
  readonly nodesById = new Map<string, WorldNode>();
  readonly edgesById = new Map<string, WorldEdge>();
  readonly tiles = new Map<string, string[]>();
  readonly edgesByNode = new Map<string, string[]>();
  readonly bounds: Bounds;

  constructor(graph: WorldGraph, readonly tileSize = TILE_SIZE) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const node of graph.nodes) {
      this.nodesById.set(node.id, node);
      const key = tileKey(node.position, tileSize);
      const list = this.tiles.get(key);
      if (list) list.push(node.id);
      else this.tiles.set(key, [node.id]);
      const w = node.size?.w ?? 240;
      const h = node.size?.h ?? 120;
      if (node.position.x < minX) minX = node.position.x;
      if (node.position.y < minY) minY = node.position.y;
      if (node.position.x + w > maxX) maxX = node.position.x + w;
      if (node.position.y + h > maxY) maxY = node.position.y + h;
    }
    for (const region of graph.world.regions) {
      const b = region.bounds;
      if (b.x < minX) minX = b.x;
      if (b.y < minY) minY = b.y;
      if (b.x + b.w > maxX) maxX = b.x + b.w;
      if (b.y + b.h > maxY) maxY = b.y + b.h;
    }
    for (const edge of graph.edges) {
      this.edgesById.set(edge.id, edge);
      for (const end of [edge.from, edge.to]) {
        const list = this.edgesByNode.get(end);
        if (list) list.push(edge.id);
        else this.edgesByNode.set(end, [edge.id]);
      }
    }
    this.bounds = Number.isFinite(minX) ? { x: minX, y: minY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) } : { x: 0, y: 0, w: 1, h: 1 };
  }

  nodesInTiles(keys: readonly string[]): WorldNode[] {
    const out: WorldNode[] = [];
    for (const key of keys) {
      for (const id of this.tiles.get(key) ?? []) {
        const node = this.nodesById.get(id);
        if (node) out.push(node);
      }
    }
    return out;
  }

  /** Edges with at least one endpoint in `nodeIds`. */
  edgesTouching(nodeIds: Iterable<string>): WorldEdge[] {
    const seen = new Set<string>();
    const out: WorldEdge[] = [];
    for (const id of nodeIds) {
      for (const edgeId of this.edgesByNode.get(id) ?? []) {
        if (seen.has(edgeId)) continue;
        seen.add(edgeId);
        const edge = this.edgesById.get(edgeId);
        if (edge) out.push(edge);
      }
    }
    return out;
  }

  /** Breadth-first neighborhood up to `depth` hops, capped at `limit` nodes. */
  neighborhood(id: string, depth: number, limit = 400): { nodes: WorldNode[]; edges: WorldEdge[] } {
    const start = this.nodesById.get(id);
    if (!start) return { nodes: [], edges: [] };
    const visited = new Set<string>([id]);
    let frontier = [id];
    for (let d = 0; d < depth && frontier.length && visited.size < limit; d++) {
      const next: string[] = [];
      for (const current of frontier) {
        for (const edgeId of this.edgesByNode.get(current) ?? []) {
          const edge = this.edgesById.get(edgeId);
          if (!edge) continue;
          const other = edge.from === current ? edge.to : edge.from;
          if (!visited.has(other) && visited.size < limit) {
            visited.add(other);
            next.push(other);
          }
        }
      }
      frontier = next;
    }
    const nodes = [...visited].map((n) => this.nodesById.get(n)).filter((n): n is WorldNode => Boolean(n));
    const edges = this.edgesTouching(visited).filter((e) => visited.has(e.from) && visited.has(e.to));
    return { nodes, edges };
  }
}
