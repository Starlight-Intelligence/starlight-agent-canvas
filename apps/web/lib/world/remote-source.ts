import { TILE_SIZE } from '@starlight-agent-canvas/world';
import type { Bounds, OpError, WorldEdge, WorldNode } from '@starlight-agent-canvas/world';
import {
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

/**
 * Remote adapter for the L2 Cloudflare Worker (one Durable Object per world).
 *
 * STATUS: provisional. L2 (`agent/claude-cloud/world-edge`) was not merged when
 * this was written, so the wire format below follows spec section 8 tool names
 * and is not tested against a live Worker. Calls go to
 * `POST {baseUrl}/worlds/{worldId}/tools/{tool}` with the tool input as JSON,
 * and the change feed is a WebSocket at `{baseUrl}/worlds/{worldId}/live`.
 * When L2 lands, adjust `call()` and `connect()` only; the canvas does not change.
 *
 * Enabled with NEXT_PUBLIC_WORLD_SOURCE=remote and NEXT_PUBLIC_WORLD_WORKER_URL.
 */
export class RemoteWorldSource implements WorldSource {
  readonly kind = 'remote' as const;
  private listeners = new Set<(event: WorldEvent) => void>();
  private log: ActivityEntry[] = [];
  private nodes = new Map<string, WorldNode>();
  /** Positions learned from search hits, so a cache miss can load the right area. */
  private hitPositions = new Map<string, { x: number; y: number }>();
  private socket: WebSocket | null = null;

  constructor(
    private readonly baseUrl: string,
    private readonly worldId: string,
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
  ) {}

  private async call<T>(tool: string, input: Record<string, unknown>): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, '')}/worlds/${encodeURIComponent(this.worldId)}/tools/${tool}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ worldId: this.worldId, ...input }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      const err = (body as { error?: OpError } | null)?.error;
      throw Object.assign(new Error(err?.message ?? `World worker ${tool} failed with HTTP ${res.status}`), { detail: err });
    }
    return body as T;
  }

  private remember(nodes: WorldNode[]): void {
    for (const n of nodes) this.nodes.set(n.id, n);
  }

  async loadWorld(): Promise<WorldSummary> {
    const out = await this.call<WorldSummary>('get_world', {});
    this.connect();
    return out;
  }

  async getTiles(tileKeys: readonly string[]): Promise<TileBatch> {
    if (!tileKeys.length) return { tileKeys: [], nodes: [], edges: [] };
    const coords = tileKeys.map((k) => k.split(':').map(Number) as [number, number]);
    const xs = coords.map((c) => c[0]);
    const ys = coords.map((c) => c[1]);
    const bounds: Bounds = {
      x: Math.min(...xs) * TILE_SIZE,
      y: Math.min(...ys) * TILE_SIZE,
      w: (Math.max(...xs) - Math.min(...xs) + 1) * TILE_SIZE,
      h: (Math.max(...ys) - Math.min(...ys) + 1) * TILE_SIZE,
    };
    const batch = await this.getRegion({ bounds });
    return { ...batch, tileKeys: [...tileKeys] };
  }

  async getClusters(): Promise<RegionCluster[]> {
    return this.call<RegionCluster[]>('get_region', { level: 'cluster' });
  }

  async getRegion(query: RegionQuery): Promise<TileBatch> {
    const out = await this.call<{ nodes: WorldNode[]; edges: WorldEdge[] }>('get_region', query as Record<string, unknown>);
    this.remember(out.nodes);
    return { tileKeys: [], nodes: out.nodes, edges: out.edges };
  }

  async search(query: string, limit = 12): Promise<SearchHit[]> {
    const hits = await this.call<SearchHit[]>('search', { query, limit });
    for (const h of hits) this.hitPositions.set(h.id, h.position);
    return hits;
  }

  async getNode(id: string): Promise<WorldNode | null> {
    const cached = this.nodes.get(id);
    if (cached) return cached;
    // Cache miss (search hit or deep link outside loaded tiles): load the area
    // around a known position, else ask the worker for that node's region by id.
    const at = this.hitPositions.get(id);
    try {
      if (at) await this.getRegion({ bounds: { x: at.x - 512, y: at.y - 512, w: 1024, h: 1024 } });
      else await this.call<{ nodes: WorldNode[] }>('get_region', { nodeId: id }).then((r) => this.remember(r.nodes ?? []));
    } catch {
      return null;
    }
    return this.nodes.get(id) ?? null;
  }

  async getNeighborhood(id: string, depth: number): Promise<TileBatch> {
    const node = this.nodes.get(id);
    if (!node) return { tileKeys: [], nodes: [], edges: [] };
    const pad = 1200 * depth;
    return this.getRegion({ bounds: { x: node.position.x - pad, y: node.position.y - pad, w: pad * 2, h: pad * 2 } });
  }

  async getTimeline(): Promise<TileBatch> {
    // Not in the L2 tool list yet; falls back to whatever is cached.
    return { tileKeys: [], nodes: [...this.nodes.values()].filter((n) => ['story', 'book', 'chapter', 'event', 'gate'].includes(n.kind)), edges: [] };
  }

  async applyOps(ops: unknown[], harness = 'human'): Promise<OpOutcome> {
    const { summary, targetIds } = describeOps(ops, (id) => this.nodes.get(id)?.title);
    const entry: ActivityEntry = { id: `r${Date.now().toString(36)}`, harness, at: new Date().toISOString(), summary, ops: ops.length, targetIds, status: 'pending' };
    this.push(entry);
    try {
      const out = await this.call<OpOutcome>('apply_ops', { ops });
      this.push({ ...entry, status: out.ok ? 'confirmed' : 'rejected', error: out.ok ? undefined : out.error.message });
      if (!out.ok) {
        this.emit({ type: 'rollback', error: out.error });
        return out;
      }
      // Do not depend on the live feed: drop stale cached nodes and announce the
      // change so the canvas refetches its tiles at the new versions.
      for (const id of [...out.changed.nodes, ...out.changed.removedNodes]) this.nodes.delete(id);
      this.emit({
        type: 'changed',
        version: out.version,
        nodeIds: out.changed.nodes,
        edgeIds: out.changed.edges,
        removedNodeIds: out.changed.removedNodes,
        removedEdgeIds: out.changed.removedEdges,
      });
      return out;
    } catch (err) {
      const error: OpError = (err as { detail?: OpError }).detail ?? { code: 'INVALID_OP', message: err instanceof Error ? err.message : String(err) };
      this.push({ ...entry, status: 'rejected', error: error.message });
      this.emit({ type: 'rollback', error });
      return { ok: false, error };
    }
  }

  subscribe(listener: (event: WorldEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  activity(): ActivityEntry[] {
    return this.log;
  }

  private push(entry: ActivityEntry): void {
    this.log = [entry, ...this.log.filter((e) => e.id !== entry.id)].slice(0, 200);
    this.emit({ type: 'activity', entry });
  }

  private emit(event: WorldEvent): void {
    for (const l of this.listeners) l(event);
  }

  private connect(): void {
    if (this.socket || typeof WebSocket === 'undefined') return;
    try {
      const url = `${this.baseUrl.replace(/^http/, 'ws').replace(/\/$/, '')}/worlds/${encodeURIComponent(this.worldId)}/live`;
      this.socket = new WebSocket(url);
      this.socket.addEventListener('message', (msg) => {
        try {
          const data = JSON.parse(String(msg.data)) as WorldEvent;
          if (data.type === 'activity') this.push(data.entry);
          else {
            // Another client changed the world: drop stale cached copies first
            // so getNode() refetches instead of returning old versions.
            if (data.type === 'changed') for (const id of [...data.nodeIds, ...data.removedNodeIds]) this.nodes.delete(id);
            this.emit(data);
          }
        } catch {
          // Ignore frames we do not understand.
        }
      });
      this.socket.addEventListener('close', () => {
        this.socket = null;
      });
    } catch {
      this.socket = null;
    }
  }
}
