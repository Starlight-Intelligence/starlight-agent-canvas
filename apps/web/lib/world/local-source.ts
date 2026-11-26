import { applyOps as applyGraphOps, boundsIntersect, nodeBounds, parseWorldGraph, regionAt, tileKeysForBounds } from '@starlight-agent-canvas/world';
import type { Actor, CanonProposal, NodeKind, OpError, WorldEdge, WorldGraph, WorldNode } from '@starlight-agent-canvas/world';
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
  /**
   * Optional URL returning the authoritative world document. After the server
   * rejects a batch (for example STALE_VERSION because another tab saved
   * first), the source reloads from here instead of restoring its own snapshot.
   */
  reloadUrl?: string;
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
  /** Last graph the server confirmed (the whole graph when there is no server). */
  private confirmed: WorldGraph;
  /** Batches applied optimistically and still waiting for the server, oldest first. */
  private pending: PendingBatch[] = [];
  private proposalLog = new Map<string, CanonProposal>();
  private index: TileIndex;
  private listeners = new Set<(event: WorldEvent) => void>();
  private log: ActivityEntry[] = [];
  private seq = 0;

  constructor(graph: WorldGraph, private readonly options: LocalWorldSourceOptions = {}) {
    this.graph = graph;
    this.confirmed = graph;
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
    // Nodes outside every region form an "Unplaced" cluster bounded by those
    // nodes only, so regionless worlds still show something at cluster zoom.
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const node of this.graph.nodes) {
      const id = node.regionId && byRegion.has(node.regionId) ? node.regionId : (regionAt(regions, node.position)?.id ?? null);
      let cluster = byRegion.get(id);
      if (!cluster) {
        cluster = { regionId: null, title: 'Unplaced', bounds: this.index.bounds, color: '#8b8b95', total: 0, byKind: {} };
        byRegion.set(null, cluster);
      }
      if (id === null) {
        const b = nodeBounds(node);
        x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y);
        x1 = Math.max(x1, b.x + Math.max(b.w, 240)); y1 = Math.max(y1, b.y + Math.max(b.h, 120));
      }
      cluster.total += 1;
      cluster.byKind[node.kind] = (cluster.byKind[node.kind] ?? 0) + 1;
    }
    const unplaced = byRegion.get(null);
    if (unplaced && Number.isFinite(x0)) unplaced.bounds = { x: x0 - 64, y: y0 - 64, w: x1 - x0 + 128, h: y1 - y0 + 128 };
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

  private async fetchAuthoritative(): Promise<WorldGraph | null> {
    if (!this.options.reloadUrl) return null;
    try {
      const res = await (this.options.fetchImpl ?? fetch)(this.options.reloadUrl, { cache: 'no-store' });
      return res.ok ? parseWorldGraph(await res.json()) : null;
    } catch {
      return null;
    }
  }

  /** Canon proposals made through this source that are still proposed in the current graph. */
  proposals(): CanonProposal[] {
    return [...this.proposalLog.values()].filter((p) => {
      const target = p.targetType === 'node' ? this.index.nodesById.get(p.id) : this.graph.edges.find((e) => e.id === p.id);
      return target?.canon.status === 'proposed';
    });
  }

  private recordProposals(list: readonly CanonProposal[] | undefined): void {
    for (const p of list ?? []) this.proposalLog.set(`${p.targetType}:${p.id}`, p);
  }

  /**
   * Shown graph = last server-confirmed graph + every batch still waiting for
   * the server, replayed in order. A pending batch that no longer applies is
   * left out; the server will refuse it too.
   */
  private rebuild(): void {
    let graph = this.confirmed;
    for (const batch of this.pending) {
      const replay = applyGraphOps(graph, batch.ops, { actor: batch.actor });
      if (replay.ok) graph = replay.graph;
    }
    this.setGraph(graph);
  }

  /** Adopt a confirmed server state, never one older than the newest already adopted. */
  private adoptConfirmed(graph: WorldGraph): void {
    if (graph.world.version >= this.confirmed.world.version) this.confirmed = graph;
  }

  async applyOps(ops: unknown[], harness = this.options.harness ?? 'human'): Promise<OpOutcome> {
    const titleOf = (id: string) => this.index.nodesById.get(id)?.title;
    const { summary, targetIds } = describeOps(ops, titleOf);
    const actor = actorFor(harness);
    const result = applyGraphOps(this.graph, ops, { actor });
    if (!result.ok) return { ok: false, error: result.error };

    const changedEvent = (removed = true) => ({
      type: 'changed' as const,
      version: this.graph.world.version,
      nodeIds: result.changed.nodes,
      edgeIds: result.changed.edges,
      removedNodeIds: removed ? result.changed.removedNodes : [],
      removedEdgeIds: removed ? result.changed.removedEdges : [],
    });
    const entry: ActivityEntry = {
      id: `a${++this.seq}_${Date.now().toString(36)}`,
      harness,
      at: actor.at,
      summary,
      ops: ops.length,
      targetIds,
      status: this.options.persistUrl ? 'pending' : 'confirmed',
    };

    if (!this.options.persistUrl) {
      this.confirmed = result.graph;
      this.setGraph(result.graph);
      this.recordProposals(result.proposals);
      this.emit(changedEvent());
      this.pushActivity(entry);
      return { ok: true, version: result.graph.world.version, changed: result.changed, proposals: result.proposals };
    }

    // Optimistic: show the change now, confirm or reconcile below.
    const batch: PendingBatch = { ops, actor };
    this.pending.push(batch);
    this.setGraph(result.graph);
    this.emit(changedEvent());
    this.pushActivity(entry);

    let error: OpError | null = null;
    let confirmed: ConfirmBody | null = null;
    try {
      const res = await (this.options.fetchImpl ?? fetch)(this.options.persistUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ops, harness }),
      });
      const body = (await res.json().catch(() => null)) as (ConfirmBody & { ok?: boolean; error?: OpError }) | null;
      if (!res.ok || !body?.ok) error = body?.error ?? { code: 'INVALID_OP', message: `Server refused the batch (HTTP ${res.status}).` };
      else confirmed = body;
    } catch (err) {
      error = { code: 'INVALID_OP', message: `Could not reach the server: ${err instanceof Error ? err.message : String(err)}` };
    }
    this.pending = this.pending.filter((b) => b !== batch);

    if (error) {
      // Reload the server copy so a retry is based on its versions, but never
      // adopt a snapshot older than a write the server already confirmed.
      const fresh = await this.fetchAuthoritative();
      if (fresh) this.adoptConfirmed(fresh);
      this.rebuild();
      this.emit(changedEvent(false));
      this.emit({ type: 'rollback', error });
      this.pushActivity({ ...entry, status: 'rejected', error: error.message });
      return { ok: false, error };
    }

    // Adopt the server's state for what changed (its versions and stamps).
    if (confirmed?.world && Array.isArray(confirmed.nodes) && Array.isArray(confirmed.edges) && confirmed.changed) {
      if (confirmed.world.version >= this.confirmed.world.version) this.confirmed = mergeServerState(this.confirmed, confirmed as Required<ConfirmBody>);
    } else {
      const replay = applyGraphOps(this.confirmed, ops, { actor });
      if (replay.ok) this.confirmed = replay.graph;
    }
    this.rebuild();
    const proposals = confirmed?.proposals ?? result.proposals;
    this.recordProposals(proposals);
    this.emit(changedEvent());
    this.pushActivity({ ...entry, status: 'confirmed' });
    return { ok: true, version: confirmed?.version ?? result.graph.world.version, changed: result.changed, proposals };
  }
}

interface PendingBatch {
  ops: unknown[];
  actor: Actor;
}

/** Success body of `POST /api/worlds/[worldId]/ops`. Older servers send only version, changed and proposals. */
interface ConfirmBody {
  version?: number;
  changed?: { nodes: string[]; edges: string[]; removedNodes: string[]; removedEdges: string[] };
  proposals?: CanonProposal[];
  world?: WorldGraph['world'];
  nodes?: WorldNode[];
  edges?: WorldEdge[];
}

/** `base` with the server's copies of changed nodes and edges, and its world record. */
function mergeServerState(base: WorldGraph, body: Required<ConfirmBody>): WorldGraph {
  const nodes = new Map(base.nodes.map((n) => [n.id, n]));
  const edges = new Map(base.edges.map((e) => [e.id, e]));
  for (const id of body.changed.removedNodes) nodes.delete(id);
  for (const id of body.changed.removedEdges) edges.delete(id);
  for (const n of body.nodes) nodes.set(n.id, n);
  for (const e of body.edges) edges.set(e.id, e);
  return { ...base, world: body.world, nodes: [...nodes.values()], edges: [...edges.values()] };
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
