import { applyOps as applyGraphOps, boundsIntersect, nodeBounds, regionAt, tileKeysForBounds } from '@starlight-agent-canvas/world';
import type { NodeKind, OpError, WorldGraph, WorldNode } from '@starlight-agent-canvas/world';
import { TileIndex } from './tile-index';
import { regionTint } from './tints';
import {
  actorFor,
  describeOps,
  type ActivityEntry,
  type OpOutcome,
  type RegionCluster,
  type RegionQuery,
  type SearchHit,
  type TileBatch,
  type WorldEvent,
  type WorldSource,
  type WorldSummary,
} from './source';
import { timelineNodes } from './layouts';

export interface LocalWorldSourceOptions {
  /**
   * Optional URL that accepts `POST { ops, harness }` and applies the batch to
   * the server copy. Without it, edits live only in this tab.
   */
  persistUrl?: string;
  /** Harness stamped on edits made in this tab. */
  harness?: string;
  fetchImpl?: typeof fetch;
}

/**
 * A world held in memory, loaded from a JSON document (local file through the
 * `/api/worlds/[worldId]` route, or generated for the stress route). It still
 * answers tile queries so the canvas code path is the same as for the remote
 * adapter.
 */
export class LocalWorldSource implements WorldSource {
  readonly kind = 'local' as const;
  private graph: WorldGraph;
  private index: TileIndex;
  private listeners = new Set<(event: WorldEvent) => void>();
  private log: ActivityEntry[] = [];
  private seq = 0;

  constructor(graph: WorldGraph, private readonly options: LocalWorldSourceOptions = {}) {
    this.graph = graph;
    this.index = new TileIndex(graph);
    this.log = seedActivity(graph);
  }

  /** Synchronous snapshot, for tests and the minimap. */
  snapshot(): WorldGraph {
    return this.graph;
  }

  async loadWorld(): Promise<WorldSummary> {
    const byKind: Partial<Record<NodeKind, number>> = {};
    for (const node of this.graph.nodes) byKind[node.kind] = (byKind[node.kind] ?? 0) + 1;
    return {
      world: this.graph.world,
      counts: { nodes: this.graph.nodes.length, edges: this.graph.edges.length, byKind },
      bounds: this.index.bounds,
    };
  }

  async getTiles(tileKeys: readonly string[]): Promise<TileBatch> {
    const nodes = this.index.nodesInTiles(tileKeys);
    const edges = this.index.edgesTouching(nodes.map((n) => n.id));
    return { tileKeys: [...tileKeys], nodes, edges };
  }

  async getClusters(): Promise<RegionCluster[]> {
    const regions = this.graph.world.regions;
    const byRegion = new Map<string | null, RegionCluster>();
    regions.forEach((region, i) => {
      byRegion.set(region.id, {
        regionId: region.id,
        title: region.title,
        bounds: region.bounds,
        color: regionTint(region.color, i),
        total: 0,
        byKind: {},
      });
    });
    for (const node of this.graph.nodes) {
      const id = node.regionId && byRegion.has(node.regionId) ? node.regionId : (regionAt(regions, node.position)?.id ?? null);
      let cluster = byRegion.get(id);
      if (!cluster) {
        cluster = { regionId: null, title: 'Unplaced', bounds: this.index.bounds, color: '#8b8b95', total: 0, byKind: {} };
        byRegion.set(null, cluster);
      }
      cluster.total += 1;
      cluster.byKind[node.kind] = (cluster.byKind[node.kind] ?? 0) + 1;
    }
    return [...byRegion.values()];
  }

  async getRegion(query: RegionQuery): Promise<TileBatch> {
    if ('regionId' in query) {
      const region = this.graph.world.regions.find((r) => r.id === query.regionId);
      if (!region) return { tileKeys: [], nodes: [], edges: [] };
      const keys = tileKeysForBounds(region.bounds);
      const nodes = this.index.nodesInTiles(keys).filter((n) => n.regionId === region.id || boundsIntersect(nodeBounds(n), region.bounds));
      return { tileKeys: keys, nodes, edges: this.index.edgesTouching(nodes.map((n) => n.id)) };
    }
    const keys = tileKeysForBounds(query.bounds);
    const nodes = this.index.nodesInTiles(keys).filter((n) => boundsIntersect(nodeBounds(n), query.bounds));
    return { tileKeys: keys, nodes, edges: this.index.edgesTouching(nodes.map((n) => n.id)) };
  }

  async search(query: string, limit = 12): Promise<SearchHit[]> {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const starts: WorldNode[] = [];
    const contains: WorldNode[] = [];
    for (const node of this.graph.nodes) {
      const title = node.title.toLowerCase();
      if (title.startsWith(q)) starts.push(node);
      else if (title.includes(q) || node.tags.some((t) => t.toLowerCase() === q)) contains.push(node);
      if (starts.length >= limit) break;
    }
    return [...starts, ...contains].slice(0, limit).map((n) => ({
      id: n.id,
      kind: n.kind,
      title: n.title,
      summary: n.summary,
      position: n.position,
      regionId: n.regionId,
    }));
  }

  async getNode(id: string): Promise<WorldNode | null> {
    return this.index.nodesById.get(id) ?? null;
  }

  async getNeighborhood(id: string, depth: number): Promise<TileBatch> {
    const { nodes, edges } = this.index.neighborhood(id, Math.max(1, Math.min(3, depth)));
    return { tileKeys: [], nodes, edges };
  }

  async getTimeline(): Promise<TileBatch> {
    const nodes = timelineNodes(this.graph.nodes, this.graph.edges);
    const ids = new Set(nodes.map((n) => n.id));
    const edges = this.graph.edges.filter((e) => ids.has(e.from) && ids.has(e.to) && (e.relation === 'precedes' || e.relation === 'follows' || e.relation === 'part-of'));
    return { tileKeys: [], nodes, edges };
  }

  activity(): ActivityEntry[] {
    return this.log;
  }

  subscribe(listener: (event: WorldEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: WorldEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private setGraph(graph: WorldGraph): void {
    this.graph = graph;
    this.index = new TileIndex(graph);
  }

  private pushActivity(entry: ActivityEntry): void {
    const i = this.log.findIndex((e) => e.id === entry.id);
    if (i >= 0) this.log = [entry, ...this.log.slice(0, i), ...this.log.slice(i + 1)];
    else this.log = [entry, ...this.log].slice(0, 200);
    this.emit({ type: 'activity', entry });
  }

  async applyOps(ops: unknown[], harness = this.options.harness ?? 'human'): Promise<OpOutcome> {
    const before = this.graph;
    const titleOf = (id: string) => this.index.nodesById.get(id)?.title;
    const { summary, targetIds } = describeOps(ops, titleOf);
    const actor = actorFor(harness);
    const result = applyGraphOps(before, ops, { actor });
    if (!result.ok) return { ok: false, error: result.error };

    // Optimistic: show the change now, confirm or roll back below.
    this.setGraph(result.graph);
    const entry: ActivityEntry = {
      id: `a${++this.seq}_${Date.now().toString(36)}`,
      harness,
      at: actor.at,
      summary,
      ops: ops.length,
      targetIds,
      status: this.options.persistUrl ? 'pending' : 'confirmed',
    };
    this.emit({
      type: 'changed',
      version: result.graph.world.version,
      nodeIds: result.changed.nodes,
      edgeIds: result.changed.edges,
      removedNodeIds: result.changed.removedNodes,
      removedEdgeIds: result.changed.removedEdges,
    });
    this.pushActivity(entry);

    if (this.options.persistUrl) {
      let error: OpError | null = null;
      try {
        const res = await (this.options.fetchImpl ?? fetch)(this.options.persistUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ops, harness }),
        });
        const body = (await res.json().catch(() => null)) as { ok?: boolean; error?: OpError } | null;
        if (!res.ok || !body?.ok) error = body?.error ?? { code: 'INVALID_OP', message: `Server refused the batch (HTTP ${res.status}).` };
      } catch (err) {
        error = { code: 'INVALID_OP', message: `Could not reach the server: ${err instanceof Error ? err.message : String(err)}` };
      }
      if (error) {
        // Roll back only when no newer batch landed on top of this one.
        if (this.graph === result.graph) this.setGraph(before);
        this.emit({
          type: 'changed',
          version: this.graph.world.version,
          nodeIds: result.changed.nodes,
          edgeIds: result.changed.edges,
          removedNodeIds: [],
          removedEdgeIds: [],
        });
        this.emit({ type: 'rollback', error });
        this.pushActivity({ ...entry, status: 'rejected', error: error.message });
        return { ok: false, error };
      }
      this.pushActivity({ ...entry, status: 'confirmed' });
    }

    return { ok: true, version: result.graph.world.version, changed: result.changed, proposals: result.proposals };
  }
}

/** One activity line per harness that created nodes, from `createdBy`. */
export function seedActivity(graph: WorldGraph): ActivityEntry[] {
  const groups = new Map<string, { at: string; count: number; ids: string[] }>();
  for (const node of graph.nodes) {
    const key = node.createdBy.harness;
    const group = groups.get(key);
    if (group) {
      group.count += 1;
      if (group.ids.length < 5) group.ids.push(node.id);
      if (node.createdBy.at > group.at) group.at = node.createdBy.at;
    } else {
      groups.set(key, { at: node.createdBy.at, count: 1, ids: [node.id] });
    }
  }
  return [...groups.entries()]
    .sort((a, b) => (a[1].at < b[1].at ? 1 : -1))
    .map(([harness, g], i) => ({
      id: `seed_${i}`,
      harness,
      at: g.at,
      summary: `Created ${g.count.toLocaleString('en-US')} ${g.count === 1 ? 'node' : 'nodes'}`,
      ops: g.count,
      targetIds: g.ids,
      status: 'confirmed' as const,
    }));
}
