import { Agent, type Connection, type ConnectionContext, type WSMessage } from 'agents';
import {
  applyOps,
  boundsSchema,
  entityIdSchema,
  graphOpSchema,
  LIMITS,
  newId,
  validateWorldGraph,
  WORLD_ID_PATTERN,
  type Actor,
  type ApplyResult,
  type GraphOp,
  type OpError,
  type World,
  type WorldEdge,
  type WorldGraph,
  type WorldNode,
} from '@starlight-agent-canvas/world';
import { z } from 'zod';
import { decodePrincipal, PRINCIPAL_HEADER, type Principal } from './auth.js';
import type { Env } from './env.js';
import { syncIndex, toHit, type SearchHit } from './indexing.js';
import { LAYOUT_STRATEGIES, layoutNodes, type LayoutStrategy } from './layout.js';
import {
  type ClusterSummary,
  type EdgeSummary,
  type NodeCard,
  projectEdges,
  queryTiles,
  REGION_LIMITS,
  regionQuerySchema,
  resolveLevel,
  summarizeClusters,
  tileCountFor,
  toCard,
} from './region.js';
import { WorldStore, type CanonProposalRow, type OpsLogEntry } from './store.js';

/**
 * Small, synced Agent state. Never holds the graph: a 100k-node world cannot
 * be broadcast whole. Clients read regions on demand and apply `world.diff`
 * messages to what they hold.
 */
export interface WorldSummaryState {
  worldId: string;
  title: string;
  version: number;
  updatedAt: string;
  nodeCount: number;
  edgeCount: number;
  lastChange: { seq: number; harness: string; actor: string | null; at: string } | null;
}

export interface WorldDiffMessage {
  type: 'world.diff';
  worldId: string;
  version: number;
  seq: number;
  harness: string;
  actor: string | null;
  nodes: WorldNode[];
  edges: WorldEdge[];
  removedNodes: string[];
  removedEdges: string[];
}

export type WriteResult =
  | {
    ok: true;
    version: number;
    seq: number;
    nodes: WorldNode[];
    edges: WorldEdge[];
    removedNodes: string[];
    removedEdges: string[];
    proposals: Extract<ApplyResult, { ok: true }>['proposals'];
  }
  | { ok: false; version: number; error: OpError };

export type RegionResult =
  | {
    ok: true;
    version: number;
    level: 'cluster' | 'card' | 'full';
    bounds: { x: number; y: number; w: number; h: number };
    regions: World['regions'];
    clusters: ClusterSummary[];
    nodes: (WorldNode | NodeCard)[];
    edges: (WorldEdge | EdgeSummary)[];
    /** True when either list was cut; see nodesTruncated and edgesTruncated. */
    truncated: boolean;
    nodesTruncated: boolean;
    edgesTruncated: boolean;
  }
  | { ok: false; version: number; error: { code: string; message: string } };

const MAX_LOG_PAGE = 500;

export const canonProposalInputSchema = z.strictObject({
  title: z.string().min(1).max(LIMITS.titleMax),
  targets: z.array(z.strictObject({
    type: z.enum(['node', 'edge']),
    id: entityIdSchema,
    baseVersion: z.number().int().positive(),
  })).min(1).max(100),
  rationale: z.string().min(1).max(LIMITS.summaryMax),
});
export type CanonProposalInput = z.infer<typeof canonProposalInputSchema>;

function actorFor(principal: Principal): Actor {
  return { harness: principal.harness, actor: principal.actor, at: new Date().toISOString() };
}

/** Rejects any canon status 'canon' anywhere in an imported graph. */
function containsCanon(graph: WorldGraph): string | null {
  for (const node of graph.nodes) if (node.canon.status === 'canon') return node.id;
  for (const edge of graph.edges) if (edge.canon.status === 'canon') return edge.id;
  return null;
}

/**
 * One Durable Object per world; the instance name is the world id.
 *
 * Writes: every change goes through `applyOps` from @starlight-agent-canvas/world
 * on a subgraph loaded for the batch, inside one SQLite transaction, then
 * lands in the append-only ops_log with the caller's harness and actor.
 * Canon can never be written here: `applyOps` refuses it and there is no
 * promote path in this class.
 */
export class WorldAgent extends Agent<Env, WorldSummaryState> {
  initialState: WorldSummaryState = {
    worldId: '',
    title: '',
    version: 0,
    updatedAt: new Date(0).toISOString(),
    nodeCount: 0,
    edgeCount: 0,
    lastChange: null,
  };

  #store: WorldStore | null = null;
  /**
   * Index sync jobs run one after another, in commit order. Without this a
   * slow job for an older batch could overwrite rows a newer batch wrote.
   */
  #indexQueue: Promise<void> = Promise.resolve();

  private get store(): WorldStore {
    if (!this.#store) {
      if (!WORLD_ID_PATTERN.test(this.name) || this.name.length > LIMITS.idMax) {
        throw new Error(`Invalid world id ${JSON.stringify(this.name)}.`);
      }
      this.#store = new WorldStore(this.ctx.storage.sql, this.name);
      this.#store.migrate();
    }
    return this.#store;
  }

  // -------------------------------------------------------------- reads ----

  getWorldInfo(): { world: World; counts: ReturnType<WorldStore['counts']>; openProposals: number } {
    const store = this.store;
    return { world: store.getWorld(), counts: store.counts(), openProposals: store.listProposals('open').length };
  }

  getRegion(input: unknown): RegionResult {
    const store = this.store;
    const world = store.getWorld();
    const parsed = regionQuerySchema.safeParse(input);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return { ok: false, version: world.version, error: { code: 'INVALID_INPUT', message: `${issue?.path.join('.') || 'query'}: ${issue?.message ?? 'invalid'}` } };
    }
    const query = parsed.data;
    const region = query.regionId ? store.getRegion(query.regionId) : null;
    if (query.regionId && !region) {
      return { ok: false, version: world.version, error: { code: 'NOT_FOUND', message: `Region ${query.regionId} does not exist.` } };
    }
    const bounds = query.bounds ?? region!.bounds;
    if (tileCountFor(bounds) > REGION_LIMITS.maxTiles) {
      return {
        ok: false,
        version: world.version,
        error: { code: 'BOUNDS_TOO_LARGE', message: `Bounds cover more than ${REGION_LIMITS.maxTiles} tiles. Zoom in or split the request.` },
      };
    }
    const level = resolveLevel(query);
    const tiles = queryTiles(bounds);
    const regionFilter = query.bounds ? undefined : query.regionId;

    if (level === 'cluster') {
      return {
        ok: true,
        version: world.version,
        level,
        bounds,
        regions: world.regions,
        clusters: summarizeClusters(store.tileCounts(tiles, { regionId: regionFilter, kinds: query.kinds })),
        nodes: [],
        edges: [],
        truncated: false,
        nodesTruncated: false,
        edgesTruncated: false,
      };
    }

    const limit = query.limit ?? REGION_LIMITS.defaultNodes;
    const rows = store.nodesInTiles(tiles, bounds, { regionId: regionFilter, limit: limit + 1, kinds: query.kinds });
    const truncated = rows.length > limit;
    const nodes = truncated ? rows.slice(0, limit) : rows;
    const edgeRows = store.edgesTouching(nodes.map((n) => n.id), REGION_LIMITS.maxEdges + 1);
    const edgesTruncated = edgeRows.length > REGION_LIMITS.maxEdges;
    const edges = edgesTruncated ? edgeRows.slice(0, REGION_LIMITS.maxEdges) : edgeRows;
    return {
      ok: true,
      version: world.version,
      level,
      bounds,
      regions: world.regions,
      clusters: [],
      nodes: level === 'full' ? nodes : nodes.map(toCard),
      edges: projectEdges(edges, level),
      truncated: truncated || edgesTruncated,
      nodesTruncated: truncated,
      edgesTruncated,
    };
  }

  getNodesById(ids: string[]): WorldNode[] {
    return this.store.getNodes(z.array(entityIdSchema).max(1000).parse(ids));
  }

  searchLocal(query: string, kinds: string[] | undefined, limit: number): SearchHit[] {
    return this.store.searchLike(query, { kinds, limit: Math.min(Math.max(1, limit), 100) }).map((n) => toHit(n));
  }

  listOps(afterSeq = 0, limit = 100): OpsLogEntry[] {
    return this.store.listOps({ afterSeq, limit: Math.min(Math.max(1, limit), MAX_LOG_PAGE) });
  }

  listProposals(status?: string): CanonProposalRow[] {
    return this.store.listProposals(status);
  }

  // ------------------------------------------------------------- writes ----

  /**
   * Apply a batch of GraphOps for `principal`. Stale baseVersion, canon and
   * every other failure come back as `{ ok: false, error }` with the codes
   * from the spec; nothing is written in that case.
   */
  applyBatch(ops: unknown, principal: Principal, kind = 'ops'): WriteResult {
    return this.#write(ops, principal, kind, null);
  }

  /**
   * Mark targets 'proposed' (through proposeCanon ops) and record one canon
   * proposal row for the later PR flow. Never writes canon, never calls GitHub.
   */
  proposeCanon(input: unknown, principal: Principal): WriteResult & { proposalId?: string } {
    const parsed = canonProposalInputSchema.safeParse(input);
    if (!parsed.success) {
      return { ok: false, version: this.store.getWorld().version, error: { code: 'INVALID_OP', message: parsed.error.issues[0]?.message ?? 'Invalid proposal.' } };
    }
    const proposal = parsed.data;
    const ops = proposal.targets.map((t) => ({
      op: 'proposeCanon' as const,
      target: { type: t.type, id: t.id },
      baseVersion: t.baseVersion,
      note: proposal.rationale,
    }));
    const proposalId = newId('n', 'canon').replace(/^n_/, 'cp_');
    const result = this.#write(ops, principal, 'propose_canon', (store, actor, version) => {
      store.insertProposal({
        id: proposalId,
        title: proposal.title,
        nodeIds: proposal.targets.filter((t) => t.type === 'node').map((t) => t.id),
        edgeIds: proposal.targets.filter((t) => t.type === 'edge').map((t) => t.id),
        rationale: proposal.rationale,
        status: 'open',
        prUrl: null,
        worldVersion: version,
        harness: actor.harness,
        actor: actor.actor ?? null,
        createdAt: actor.at,
      });
    });
    return result.ok ? { ...result, proposalId } : result;
  }

  /** Compute a layout for the nodes of one region and apply it as one moveNodes op. */
  layoutRegion(regionId: string, strategy: LayoutStrategy, principal: Principal): WriteResult & { moved?: number } {
    const store = this.store;
    const region = store.getRegion(entityIdSchema.parse(regionId));
    if (!region) return { ok: false, version: store.getWorld().version, error: { code: 'NOT_FOUND', message: `Region ${regionId} does not exist.`, id: regionId } };
    if (!LAYOUT_STRATEGIES.includes(strategy)) {
      return { ok: false, version: store.getWorld().version, error: { code: 'INVALID_OP', message: `Unknown layout strategy ${String(strategy)}.` } };
    }
    const nodes = store.nodeIdsInRegion(region.id, 1000);
    const edges = store.edgesTouching(nodes.map((n) => n.id), 50_000);
    const moves = layoutNodes(nodes, edges, region.bounds, strategy);
    if (moves.length === 0) {
      return { ok: true, version: store.getWorld().version, seq: 0, nodes: [], edges: [], removedNodes: [], removedEdges: [], proposals: [], moved: 0 };
    }
    const result = this.#write([{ op: 'moveNodes', moves }], principal, `layout_region:${strategy}`, null);
    return result.ok ? { ...result, moved: moves.length } : result;
  }

  /**
   * Seed an empty world from a validated graph (for import_whiteboard).
   * Refuses non-empty worlds and any canon content.
   */
  importGraph(graph: unknown, principal: Principal): WriteResult {
    const store = this.store;
    const current = store.getWorld();
    const validated = validateWorldGraph(graph);
    if (!validated.ok) {
      const issue = validated.issues[0];
      return { ok: false, version: current.version, error: { code: 'INVALID_OP', message: `Graph is invalid: ${issue?.code} ${issue?.message ?? ''}`.trim() } };
    }
    const g = validated.graph;
    if (g.world.id !== this.name) {
      return { ok: false, version: current.version, error: { code: 'INVALID_REFERENCE', message: `Graph is for world ${g.world.id}, not ${this.name}.` } };
    }
    const canonId = containsCanon(g);
    if (canonId) {
      return { ok: false, version: current.version, error: { code: 'CANON_FORBIDDEN', message: `Import contains canon entity ${canonId}. Canon only comes from git.`, id: canonId } };
    }
    if (!store.isEmpty()) {
      return { ok: false, version: current.version, error: { code: 'DUPLICATE_ID', message: `World ${this.name} already has content. Import only seeds an empty world in v1.` } };
    }
    const actor = actorFor(principal);
    const version = current.version + 1;
    const seq = this.ctx.storage.transactionSync(() => {
      store.setWorldMeta({ title: g.world.title, summary: g.world.summary, version, updatedAt: actor.at });
      store.replaceRegions(g.world.regions);
      for (const node of g.nodes) store.upsertNode(node);
      for (const edge of g.edges) store.upsertEdge(edge);
      return store.appendLog({
        worldVersion: version,
        actor,
        kind: 'import',
        ops: [{ import: { nodes: g.nodes.length, edges: g.edges.length, regions: g.world.regions.length } }],
        changed: { nodes: g.nodes.map((n) => n.id), edges: g.edges.map((e) => e.id), removedNodes: [], removedEdges: [] },
        before: { nodes: {}, edges: {} },
      });
    });
    const changes = { nodes: g.nodes, edges: g.edges, removedNodes: [], removedEdges: [], version, seq };
    this.#publish(changes, actor);
    return { ok: true, ...changes, proposals: [] };
  }

  #write(
    rawOps: unknown,
    principal: Principal,
    kind: string,
    extra: ((store: WorldStore, actor: Actor, version: number) => void) | null,
  ): WriteResult {
    const store = this.store;
    const fail = (error: OpError): WriteResult => ({ ok: false, version: store.getWorld().version, error });
    if (!Array.isArray(rawOps)) return fail({ code: 'INVALID_OP', message: 'ops must be an array.' });
    if (rawOps.length > LIMITS.opsPerBatchMax) return fail({ code: 'INVALID_OP', message: `A batch may hold at most ${LIMITS.opsPerBatchMax} ops.` });

    // Parse once here only to know which entities to load. applyOps parses
    // again with the same schemas and owns the error codes (CANON_FORBIDDEN
    // included), so an unparseable batch goes straight to it.
    const parsed: GraphOp[] = [];
    let parseable = true;
    for (const op of rawOps) {
      const r = graphOpSchema.safeParse(op);
      if (!r.success) { parseable = false; break; }
      parsed.push(r.data);
    }
    const actor = actorFor(principal);

    type Outcome = { ok: true; changes: ReturnType<WorldStore['commit']>; result: Extract<ApplyResult, { ok: true }> } | { ok: false; error: OpError };
    const outcome = this.ctx.storage.transactionSync((): Outcome => {
      const subgraph = parseable ? store.loadSubgraph(parsed) : { schemaVersion: 'starlight.worldGraph.v1' as const, world: store.getWorld(), nodes: [], edges: [] };
      const result = applyOps(subgraph, rawOps, { actor });
      if (!result.ok) return { ok: false, error: result.error };
      if (result.applied === 0) return { ok: false, error: { code: 'INVALID_OP', message: 'Empty batch.' } };
      const changes = store.commit(subgraph, result, { actor, ops: rawOps, kind });
      extra?.(store, actor, changes.version);
      return { ok: true, changes, result };
    });
    if (!outcome.ok) return fail(outcome.error);
    this.#publish(outcome.changes, actor);
    return { ok: true, ...outcome.changes, proposals: outcome.result.proposals };
  }

  #publish(changes: { nodes: WorldNode[]; edges: WorldEdge[]; removedNodes: string[]; removedEdges: string[]; version: number; seq: number }, actor: Actor): void {
    const store = this.store;
    const world = store.getWorld();
    const counts = store.counts();
    const diff: WorldDiffMessage = {
      type: 'world.diff',
      worldId: this.name,
      version: changes.version,
      seq: changes.seq,
      harness: actor.harness,
      actor: actor.actor ?? null,
      nodes: changes.nodes,
      edges: changes.edges,
      removedNodes: changes.removedNodes,
      removedEdges: changes.removedEdges,
    };
    this.broadcast(JSON.stringify(diff));
    this.setState({
      worldId: this.name,
      title: world.title,
      version: world.version,
      updatedAt: world.updatedAt,
      nodeCount: counts.nodes,
      edgeCount: counts.edges,
      lastChange: { seq: changes.seq, harness: actor.harness, actor: actor.actor ?? null, at: actor.at },
    });
    const job = this.#indexQueue.then(() => syncIndex(this.env, world, counts.nodes, changes.nodes, changes.removedNodes)).catch((error: unknown) => {
      console.error('world-edge: index sync failed', { worldId: this.name, version: changes.version, error: String(error) });
    });
    this.#indexQueue = job;
    this.ctx.waitUntil(job);
  }

  // ------------------------------------------------- state sync guards ----

  /** Clients never set Agent state directly; all writes are ops. */
  validateStateChange(_next: WorldSummaryState, source: Connection | 'server'): void {
    if (source !== 'server') throw new Error('World state is server-owned. Send ops instead.');
  }

  // --------------------------------------------- browser and agent sockets --

  onConnect(connection: Connection, ctx: ConnectionContext): void {
    const principal = decodePrincipal(ctx.request.headers.get(PRINCIPAL_HEADER));
    if (!principal) {
      connection.close(4401, 'unauthenticated');
      return;
    }
    connection.setState({ principal });
    const info = this.getWorldInfo();
    connection.send(JSON.stringify({ type: 'world.hello', world: info.world, counts: info.counts }));
  }

  /**
   * JSON messages: {id, type: 'ops', ops} | {id, type: 'get_region', query} |
   * {id, type: 'get_world'}. Replies {id, type: 'result', result}.
   */
  onMessage(connection: Connection, message: WSMessage): void {
    if (typeof message !== 'string') return;
    let msg: { id?: unknown; type?: unknown; ops?: unknown; query?: unknown };
    try {
      msg = JSON.parse(message) as typeof msg;
    } catch {
      return;
    }
    const id = typeof msg.id === 'string' || typeof msg.id === 'number' ? msg.id : null;
    const reply = (result: unknown) => connection.send(JSON.stringify({ id, type: 'result', result }));
    const principal = (connection.state as { principal?: Principal } | null)?.principal;
    if (!principal) {
      connection.close(4401, 'unauthenticated');
      return;
    }
    try {
      if (msg.type === 'ops') reply(this.applyBatch(msg.ops, principal));
      else if (msg.type === 'get_region') reply(this.getRegion(msg.query));
      else if (msg.type === 'get_world') reply(this.getWorldInfo());
    } catch (error) {
      reply({ ok: false, error: { code: 'INVALID_OP', message: error instanceof Error ? error.message : String(error) } });
    }
  }

  /**
   * HTTP under /agents/world-agent/<worldId>[/region|/ops|/log|/proposals].
   * The Worker authenticates first and sets the principal header.
   */
  async onRequest(request: Request): Promise<Response> {
    const principal = decodePrincipal(request.headers.get(PRINCIPAL_HEADER));
    if (!principal) return Response.json({ error: { code: 'UNAUTHENTICATED', message: 'Authentication required.' } }, { status: 401 });
    const url = new URL(request.url);
    const tail = url.pathname.split('/').filter(Boolean).at(-1);
    try {
      if (request.method === 'GET' && tail === 'region') {
        const p = url.searchParams;
        const bounds = p.has('x') ? boundsSchema.parse({ x: Number(p.get('x')), y: Number(p.get('y')), w: Number(p.get('w')), h: Number(p.get('h')) }) : undefined;
        return Response.json(this.getRegion({
          ...(bounds ? { bounds } : {}),
          ...(p.get('regionId') ? { regionId: p.get('regionId') } : {}),
          ...(p.get('level') ? { level: p.get('level') } : {}),
          ...(p.get('zoom') ? { zoom: Number(p.get('zoom')) } : {}),
        }));
      }
      if (request.method === 'POST' && tail === 'ops') {
        const body = (await request.json()) as { ops?: unknown };
        const result = this.applyBatch(body.ops, principal);
        return Response.json(result, { status: result.ok ? 200 : result.error.code === 'STALE_VERSION' ? 409 : 400 });
      }
      if (request.method === 'GET' && tail === 'log') {
        return Response.json(this.listOps(Number(url.searchParams.get('after') ?? 0), Number(url.searchParams.get('limit') ?? 100)));
      }
      if (request.method === 'GET' && tail === 'proposals') return Response.json(this.listProposals(url.searchParams.get('status') ?? undefined));
      if (request.method === 'GET') return Response.json(this.getWorldInfo());
    } catch (error) {
      return Response.json({ ok: false, error: { code: 'INVALID_OP', message: error instanceof Error ? error.message : String(error) } }, { status: 400 });
    }
    return Response.json({ error: { code: 'NOT_FOUND', message: 'Unknown route.' } }, { status: 404 });
  }
}
