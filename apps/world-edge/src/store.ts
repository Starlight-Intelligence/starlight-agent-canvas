import {
  edgeIdFor,
  TILE_SIZE,
  tileKey,
  WORLD_GRAPH_SCHEMA_VERSION,
  type Actor,
  type ApplyResult,
  type GraphOp,
  type Region,
  type World,
  type WorldEdge,
  type WorldGraph,
  type WorldNode,
} from '@starlight-agent-canvas/world';
import { likePatterns } from './indexing.js';

/**
 * SQLite layout for one world inside its Durable Object.
 *
 * The full node and edge JSON lives in `data`; the other columns are
 * denormalized for indexed queries (tile, region, position, kind). Every row
 * keeps its entity `version`. The world revision lives in `world_meta`.
 *
 * Lists are passed to SQL as one JSON parameter and expanded with json_each,
 * so no query ever hits the bound-parameter limit, however many ids it uses.
 */
export const SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS world_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS regions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    x REAL NOT NULL, y REAL NOT NULL, w REAL NOT NULL, h REAL NOT NULL,
    color TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    ord INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS nodes (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    region_id TEXT,
    tile_key TEXT NOT NULL,
    x REAL NOT NULL, y REAL NOT NULL, w REAL NOT NULL, h REAL NOT NULL,
    layer INTEGER NOT NULL DEFAULT 0,
    canon_status TEXT NOT NULL,
    version INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    data TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS nodes_tile ON nodes (tile_key)`,
  `CREATE INDEX IF NOT EXISTS nodes_region ON nodes (region_id)`,
  `CREATE INDEX IF NOT EXISTS nodes_xy ON nodes (x, y)`,
  `CREATE INDEX IF NOT EXISTS nodes_kind ON nodes (kind)`,
  // Nodes wider or taller than one tile can overlap a viewport whose padded
  // tiles miss their origin tile. They are rare, so they get their own small
  // partial index and an extra query path (see nodesInTiles).
  `CREATE INDEX IF NOT EXISTS nodes_oversized ON nodes (x, y) WHERE w > ${TILE_SIZE} OR h > ${TILE_SIZE}`,
  `CREATE TABLE IF NOT EXISTS edges (
    id TEXT PRIMARY KEY,
    from_id TEXT NOT NULL,
    to_id TEXT NOT NULL,
    relation TEXT NOT NULL,
    canon_status TEXT NOT NULL,
    version INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    data TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS edges_from ON edges (from_id)`,
  `CREATE INDEX IF NOT EXISTS edges_to ON edges (to_id)`,
  // Append-only audit log. One row per accepted batch. `before` holds the
  // prior JSON of every touched entity (null when it did not exist), which is
  // what an undo needs to compute inverse ops.
  `CREATE TABLE IF NOT EXISTS ops_log (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    world_version INTEGER NOT NULL,
    harness TEXT NOT NULL,
    actor TEXT,
    at TEXT NOT NULL,
    kind TEXT NOT NULL,
    ops TEXT NOT NULL,
    changed TEXT NOT NULL,
    before TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS ops_log_version ON ops_log (world_version)`,
  // Canon proposals waiting for the git PR flow (a later lane). Rows are only
  // ever inserted here; this lane never opens PRs and never writes canon.
  `CREATE TABLE IF NOT EXISTS canon_proposals (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    node_ids TEXT NOT NULL,
    edge_ids TEXT NOT NULL,
    rationale TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    pr_url TEXT,
    world_version INTEGER NOT NULL,
    harness TEXT NOT NULL,
    actor TEXT,
    created_at TEXT NOT NULL
  )`,
  // Index sync jobs (D1 + Vectorize) that have not succeeded yet. A row is
  // written with every committed batch and deleted once the index has it, so
  // a failed sync is retried (alarm or next write) instead of being lost.
  `CREATE TABLE IF NOT EXISTS index_jobs (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    node_ids TEXT NOT NULL,
    removed_ids TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TEXT NOT NULL
  )`,
];

export interface IndexJob {
  seq: number;
  nodeIds: string[];
  removedIds: string[];
  attempts: number;
}

export const PROPOSALS_PAGE_DEFAULT = 100;
export const PROPOSALS_PAGE_MAX = 500;

type Row = Record<string, SqlStorageValue>;


export interface OpsLogEntry {
  seq: number;
  worldVersion: number;
  harness: string;
  actor: string | null;
  at: string;
  kind: string;
  /** Parsed JSON. Typed as object so Durable Object RPC stub types stay shallow. */
  ops: object[];
  changed: object;
}

export interface CanonProposalRow {
  id: string;
  title: string;
  nodeIds: string[];
  edgeIds: string[];
  rationale: string;
  status: string;
  prUrl: string | null;
  worldVersion: number;
  harness: string;
  actor: string | null;
  createdAt: string;
}

function nodeRow(node: WorldNode) {
  return [
    node.id,
    node.kind,
    node.title,
    node.regionId,
    tileKey(node.position),
    node.position.x,
    node.position.y,
    node.size?.w ?? 1,
    node.size?.h ?? 1,
    node.layer,
    node.canon.status,
    node.version,
    node.updatedAt,
    JSON.stringify(node),
  ] as const;
}

export class WorldStore {
  constructor(private readonly sql: SqlStorage, private readonly worldId: string) {}

  migrate(): void {
    for (const statement of SCHEMA_SQL) this.sql.exec(statement);
  }

  private rows(query: string, ...bindings: unknown[]): Row[] {
    return this.sql.exec(query, ...bindings).toArray() as Row[];
  }

  // ---------------------------------------------------------------- world --

  getWorld(): World {
    const meta = new Map(this.rows('SELECT key, value FROM world_meta').map((r) => [String(r.key), String(r.value)]));
    const now = new Date(0).toISOString();
    return {
      id: this.worldId,
      title: meta.get('title') ?? this.worldId,
      summary: meta.get('summary') ?? '',
      version: Number(meta.get('version') ?? 0),
      regions: this.getRegions(),
      updatedAt: meta.get('updatedAt') ?? now,
    };
  }

  setWorldMeta(fields: Partial<Pick<World, 'title' | 'summary' | 'version' | 'updatedAt'>>): void {
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) continue;
      this.sql.exec('INSERT INTO world_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, String(value));
    }
  }

  getRegions(): Region[] {
    return this.rows('SELECT id, title, x, y, w, h, color FROM regions ORDER BY ord, id').map((r) => ({
      id: String(r.id),
      title: String(r.title),
      bounds: { x: Number(r.x), y: Number(r.y), w: Number(r.w), h: Number(r.h) },
      ...(r.color ? { color: String(r.color) } : {}),
    }));
  }

  getRegion(id: string): Region | null {
    return this.getRegions().find((region) => region.id === id) ?? null;
  }

  replaceRegions(regions: readonly Region[]): void {
    this.sql.exec('DELETE FROM regions');
    regions.forEach((region, ord) => {
      this.sql.exec(
        'INSERT INTO regions (id, title, x, y, w, h, color, version, ord) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)',
        region.id, region.title, region.bounds.x, region.bounds.y, region.bounds.w, region.bounds.h, region.color ?? null, ord,
      );
    });
  }

  counts(): { nodes: number; edges: number; nodesByKind: Record<string, number>; edgesByRelation: Record<string, number> } {
    const nodesByKind: Record<string, number> = {};
    let nodes = 0;
    for (const r of this.rows('SELECT kind, COUNT(*) AS n FROM nodes GROUP BY kind')) {
      nodesByKind[String(r.kind)] = Number(r.n);
      nodes += Number(r.n);
    }
    const edgesByRelation: Record<string, number> = {};
    let edges = 0;
    for (const r of this.rows('SELECT relation, COUNT(*) AS n FROM edges GROUP BY relation')) {
      edgesByRelation[String(r.relation)] = Number(r.n);
      edges += Number(r.n);
    }
    return { nodes, edges, nodesByKind, edgesByRelation };
  }

  isEmpty(): boolean {
    const row = this.rows('SELECT (SELECT COUNT(*) FROM nodes) + (SELECT COUNT(*) FROM edges) AS n')[0];
    return Number(row?.n ?? 0) === 0;
  }

  // ---------------------------------------------------------------- reads --

  getNodes(ids: readonly string[]): WorldNode[] {
    if (ids.length === 0) return [];
    return this.rows('SELECT data FROM nodes WHERE id IN (SELECT value FROM json_each(?))', JSON.stringify(ids))
      .map((r) => JSON.parse(String(r.data)) as WorldNode);
  }

  getEdges(ids: readonly string[]): WorldEdge[] {
    if (ids.length === 0) return [];
    return this.rows('SELECT data FROM edges WHERE id IN (SELECT value FROM json_each(?))', JSON.stringify(ids))
      .map((r) => JSON.parse(String(r.data)) as WorldEdge);
  }

  /**
   * Edges with either endpoint in `nodeIds`. Reads pass a limit; the write
   * path (removeNode) passes none, because a partial set would leave
   * dangling edges behind.
   */
  edgesTouching(nodeIds: readonly string[], limit?: number): WorldEdge[] {
    if (nodeIds.length === 0) return [];
    const ids = JSON.stringify(nodeIds);
    return this.rows(
      `SELECT data FROM edges
       WHERE from_id IN (SELECT value FROM json_each(?1)) OR to_id IN (SELECT value FROM json_each(?1))
       LIMIT ?2`,
      ids, limit ?? -1,
    ).map((r) => JSON.parse(String(r.data)) as WorldEdge);
  }

  /**
   * Nodes whose box overlaps `bounds`, restricted to `tiles` so the tile index
   * does the narrowing. Ordered by layer then id for stable paging.
   */
  nodesInTiles(
    tiles: readonly string[],
    bounds: { x: number; y: number; w: number; h: number },
    options: { regionId?: string; limit: number; kinds?: readonly string[] },
  ): WorldNode[] {
    const kinds = options.kinds && options.kinds.length > 0 ? JSON.stringify(options.kinds) : null;
    // Two paths, both exact on overlap: nodes found through the padded tiles
    // (anything at most one tile wide and tall), plus oversized nodes through
    // their partial index wherever their origin is. UNION removes duplicates.
    const filters = `x < ?2 + ?4 AND x + w > ?2 AND y < ?3 + ?5 AND y + h > ?3
         AND (?6 IS NULL OR region_id = ?6)
         AND (?7 IS NULL OR kind IN (SELECT value FROM json_each(?7)))`;
    return this.rows(
      `SELECT data, layer, id FROM nodes
       WHERE tile_key IN (SELECT value FROM json_each(?1)) AND ${filters}
       UNION
       SELECT data, layer, id FROM nodes
       WHERE (w > ${TILE_SIZE} OR h > ${TILE_SIZE}) AND ${filters}
       ORDER BY layer, id
       LIMIT ?8`,
      JSON.stringify(tiles), bounds.x, bounds.y, bounds.w, bounds.h, options.regionId ?? null, kinds, options.limit,
    ).map((r) => JSON.parse(String(r.data)) as WorldNode);
  }

  /**
   * Per-tile counts by kind, for the cluster zoom level. Same node set as
   * nodesInTiles (exact overlap with `bounds`, plus oversized nodes through
   * their partial index), so cluster and card views agree on what is inside.
   */
  tileCounts(
    tiles: readonly string[],
    bounds: { x: number; y: number; w: number; h: number },
    options: { regionId?: string; kinds?: readonly string[] } = {},
  ): { tile: string; kind: string; count: number; x: number; y: number }[] {
    const kinds = options.kinds && options.kinds.length > 0 ? JSON.stringify(options.kinds) : null;
    const filters = `x < ?2 + ?4 AND x + w > ?2 AND y < ?3 + ?5 AND y + h > ?3
         AND (?6 IS NULL OR region_id = ?6)
         AND (?7 IS NULL OR kind IN (SELECT value FROM json_each(?7)))`;
    return this.rows(
      `SELECT tile_key, kind, COUNT(*) AS n, AVG(x) AS cx, AVG(y) AS cy FROM (
         SELECT id, tile_key, kind, x, y FROM nodes
         WHERE tile_key IN (SELECT value FROM json_each(?1)) AND ${filters}
         UNION
         SELECT id, tile_key, kind, x, y FROM nodes
         WHERE (w > ${TILE_SIZE} OR h > ${TILE_SIZE}) AND ${filters}
       )
       GROUP BY tile_key, kind`,
      JSON.stringify(tiles), bounds.x, bounds.y, bounds.w, bounds.h, options.regionId ?? null, kinds,
    ).map((r) => ({ tile: String(r.tile_key), kind: String(r.kind), count: Number(r.n), x: Number(r.cx), y: Number(r.cy) }));
  }

  nodeIdsInRegion(regionId: string, limit: number): WorldNode[] {
    return this.rows('SELECT data FROM nodes WHERE region_id = ? ORDER BY id LIMIT ?', regionId, limit)
      .map((r) => JSON.parse(String(r.data)) as WorldNode);
  }

  countNodesInRegion(regionId: string): number {
    return Number(this.rows('SELECT COUNT(*) AS n FROM nodes WHERE region_id = ?', regionId)[0]?.n ?? 0);
  }

  /**
   * Local fallback search over title and summary. The query becomes at most
   * LIKE_MAX_TERMS escaped patterns of at most 50 bytes each (likePatterns);
   * every pattern must match the title or the summary.
   */
  searchLike(query: string, options: { kinds?: readonly string[]; limit: number }): WorldNode[] {
    const patterns = likePatterns(query);
    if (patterns.length === 0) return [];
    const kinds = options.kinds && options.kinds.length > 0 ? JSON.stringify(options.kinds) : null;
    return this.rows(
      `SELECT data FROM nodes
       WHERE NOT EXISTS (
           SELECT 1 FROM json_each(?1) AS t
           WHERE NOT (title LIKE t.value ESCAPE '\\' OR json_extract(data, '$.summary') LIKE t.value ESCAPE '\\'))
         AND (?2 IS NULL OR kind IN (SELECT value FROM json_each(?2)))
       ORDER BY CASE WHEN title LIKE ?4 ESCAPE '\\' THEN 0 ELSE 1 END, length(title), id
       LIMIT ?3`,
      JSON.stringify(patterns), kinds, options.limit, patterns[0],
    ).map((r) => JSON.parse(String(r.data)) as WorldNode);
  }

  // ------------------------------------------------------------- subgraph --

  /**
   * The smallest graph `applyOps` needs to decide this batch exactly as it
   * would on the full graph: every region, every node and edge an op names
   * (including the deterministic id an addEdge would get), and every edge
   * touching a node that a removeNode removes. Cost is proportional to the
   * batch, not the world.
   */
  loadSubgraph(ops: readonly GraphOp[]): WorldGraph {
    const nodeIds = new Set<string>();
    const edgeIds = new Set<string>();
    const removed = new Set<string>();
    for (const op of ops) {
      switch (op.op) {
        case 'addNode': nodeIds.add(op.node.id); break;
        case 'updateNode': nodeIds.add(op.id); break;
        case 'moveNodes': for (const move of op.moves) nodeIds.add(move.id); break;
        case 'removeNode': nodeIds.add(op.id); removed.add(op.id); break;
        case 'addEdge':
          nodeIds.add(op.edge.from);
          nodeIds.add(op.edge.to);
          edgeIds.add(op.edge.id ?? edgeIdFor(this.worldId, op.edge.from, op.edge.relation, op.edge.to));
          break;
        case 'removeEdge': edgeIds.add(op.id); break;
        case 'proposeCanon':
          if (op.target.type === 'node') nodeIds.add(op.target.id);
          else edgeIds.add(op.target.id);
          break;
      }
    }
    const edges = new Map<string, WorldEdge>();
    for (const edge of this.getEdges([...edgeIds])) edges.set(edge.id, edge);
    for (const edge of this.edgesTouching([...removed])) edges.set(edge.id, edge);
    return {
      schemaVersion: WORLD_GRAPH_SCHEMA_VERSION,
      world: this.getWorld(),
      nodes: this.getNodes([...nodeIds]),
      edges: [...edges.values()],
    };
  }

  // --------------------------------------------------------------- writes --

  upsertNode(node: WorldNode): void {
    this.sql.exec(
      `INSERT INTO nodes (id, kind, title, region_id, tile_key, x, y, w, h, layer, canon_status, version, updated_at, data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, title = excluded.title, region_id = excluded.region_id,
         tile_key = excluded.tile_key, x = excluded.x, y = excluded.y, w = excluded.w, h = excluded.h,
         layer = excluded.layer, canon_status = excluded.canon_status, version = excluded.version,
         updated_at = excluded.updated_at, data = excluded.data`,
      ...nodeRow(node),
    );
  }

  upsertEdge(edge: WorldEdge): void {
    this.sql.exec(
      `INSERT INTO edges (id, from_id, to_id, relation, canon_status, version, updated_at, data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET from_id = excluded.from_id, to_id = excluded.to_id, relation = excluded.relation,
         canon_status = excluded.canon_status, version = excluded.version, updated_at = excluded.updated_at, data = excluded.data`,
      edge.id, edge.from, edge.to, edge.relation, edge.canon.status, edge.version, edge.updatedAt, JSON.stringify(edge),
    );
  }

  /**
   * Persist a successful applyOps result computed on `subgraph`. Returns the
   * changed entities so callers can broadcast and index them.
   */
  commit(
    subgraph: WorldGraph,
    result: Extract<ApplyResult, { ok: true }>,
    log: { actor: Actor; ops: readonly unknown[]; kind: string },
  ): { nodes: WorldNode[]; edges: WorldEdge[]; removedNodes: string[]; removedEdges: string[]; version: number; seq: number } {
    const nextNodes = new Map(result.graph.nodes.map((n) => [n.id, n]));
    const nextEdges = new Map(result.graph.edges.map((e) => [e.id, e]));
    const priorNodes = new Map(subgraph.nodes.map((n) => [n.id, n]));
    const priorEdges = new Map(subgraph.edges.map((e) => [e.id, e]));

    const nodes = result.changed.nodes.map((id) => nextNodes.get(id)!).filter(Boolean);
    const edges = result.changed.edges.map((id) => nextEdges.get(id)!).filter(Boolean);
    const { removedNodes, removedEdges } = result.changed;

    const before = {
      nodes: Object.fromEntries([...result.changed.nodes, ...removedNodes].map((id) => [id, priorNodes.get(id) ?? null])),
      edges: Object.fromEntries([...result.changed.edges, ...removedEdges].map((id) => [id, priorEdges.get(id) ?? null])),
    };

    for (const node of nodes) this.upsertNode(node);
    for (const edge of edges) this.upsertEdge(edge);
    if (removedEdges.length > 0) this.sql.exec('DELETE FROM edges WHERE id IN (SELECT value FROM json_each(?))', JSON.stringify(removedEdges));
    if (removedNodes.length > 0) this.sql.exec('DELETE FROM nodes WHERE id IN (SELECT value FROM json_each(?))', JSON.stringify(removedNodes));

    const version = result.graph.world.version;
    this.setWorldMeta({ version, updatedAt: result.graph.world.updatedAt });
    const seq = this.appendLog({
      worldVersion: version,
      actor: log.actor,
      kind: log.kind,
      ops: log.ops,
      changed: result.changed,
      before,
    });
    return { nodes, edges, removedNodes, removedEdges, version, seq };
  }

  appendLog(entry: { worldVersion: number; actor: Actor; kind: string; ops: readonly unknown[]; changed: unknown; before: unknown }): number {
    const row = this.rows(
      `INSERT INTO ops_log (world_version, harness, actor, at, kind, ops, changed, before)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING seq`,
      entry.worldVersion, entry.actor.harness, entry.actor.actor ?? null, entry.actor.at, entry.kind,
      JSON.stringify(entry.ops), JSON.stringify(entry.changed), JSON.stringify(entry.before),
    )[0];
    return Number(row?.seq ?? 0);
  }

  listOps(options: { afterSeq?: number; limit: number }): OpsLogEntry[] {
    return this.rows(
      'SELECT seq, world_version, harness, actor, at, kind, ops, changed FROM ops_log WHERE seq > ? ORDER BY seq LIMIT ?',
      options.afterSeq ?? 0, options.limit,
    ).map((r) => ({
      seq: Number(r.seq),
      worldVersion: Number(r.world_version),
      harness: String(r.harness),
      actor: r.actor === null ? null : String(r.actor),
      at: String(r.at),
      kind: String(r.kind),
      ops: JSON.parse(String(r.ops)) as object[],
      changed: JSON.parse(String(r.changed)) as object,
    }));
  }

  insertProposal(row: CanonProposalRow): void {
    this.sql.exec(
      `INSERT INTO canon_proposals (id, title, node_ids, edge_ids, rationale, status, pr_url, world_version, harness, actor, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.id, row.title, JSON.stringify(row.nodeIds), JSON.stringify(row.edgeIds), row.rationale, row.status,
      row.prUrl, row.worldVersion, row.harness, row.actor, row.createdAt,
    );
  }

  countProposals(status?: string): number {
    return Number(this.rows('SELECT COUNT(*) AS n FROM canon_proposals WHERE (?1 IS NULL OR status = ?1)', status ?? null)[0]?.n ?? 0);
  }

  /**
   * One page of proposals in insertion order. `cursor` is the opaque
   * `nextCursor` of the previous page (a rowid); null when there is no more.
   */
  listProposals(options: { status?: string; limit?: number; cursor?: string } = {}): { proposals: CanonProposalRow[]; nextCursor: string | null } {
    const limit = Math.min(Math.max(1, Math.floor(options.limit ?? PROPOSALS_PAGE_DEFAULT)), PROPOSALS_PAGE_MAX);
    if (options.cursor !== undefined && !/^\d{1,15}$/.test(options.cursor)) throw new Error('Invalid cursor.');
    const after = options.cursor === undefined ? 0 : Number(options.cursor);
    const rows = this.rows(
      'SELECT rowid AS rid, * FROM canon_proposals WHERE (?1 IS NULL OR status = ?1) AND rowid > ?2 ORDER BY rowid LIMIT ?3',
      options.status ?? null, after, limit + 1,
    );
    const page = rows.slice(0, limit);
    const nextCursor = rows.length > limit ? String(page.at(-1)!.rid) : null;
    return { proposals: page.map((r) => this.proposalRow(r)), nextCursor };
  }

  private proposalRow(r: Row): CanonProposalRow {
    return {
      id: String(r.id),
      title: String(r.title),
      nodeIds: JSON.parse(String(r.node_ids)) as string[],
      edgeIds: JSON.parse(String(r.edge_ids)) as string[],
      rationale: String(r.rationale),
      status: String(r.status),
      prUrl: r.pr_url === null ? null : String(r.pr_url),
      worldVersion: Number(r.world_version),
      harness: String(r.harness),
      actor: r.actor === null ? null : String(r.actor),
      createdAt: String(r.created_at),
    };
  }

  // ----------------------------------------------------------- index jobs --

  enqueueIndexJob(nodeIds: readonly string[], removedIds: readonly string[], at: string): void {
    if (nodeIds.length === 0 && removedIds.length === 0) return;
    this.sql.exec('INSERT INTO index_jobs (node_ids, removed_ids, created_at) VALUES (?, ?, ?)', JSON.stringify(nodeIds), JSON.stringify(removedIds), at);
  }

  /** Oldest pending job, or null. Jobs run strictly in order. */
  nextIndexJob(): IndexJob | null {
    const r = this.rows('SELECT seq, node_ids, removed_ids, attempts FROM index_jobs ORDER BY seq LIMIT 1')[0];
    if (!r) return null;
    return { seq: Number(r.seq), nodeIds: JSON.parse(String(r.node_ids)) as string[], removedIds: JSON.parse(String(r.removed_ids)) as string[], attempts: Number(r.attempts) };
  }

  completeIndexJob(seq: number): void {
    this.sql.exec('DELETE FROM index_jobs WHERE seq = ?', seq);
  }

  failIndexJob(seq: number, error: string): void {
    this.sql.exec('UPDATE index_jobs SET attempts = attempts + 1, last_error = ? WHERE seq = ?', error.slice(0, 1000), seq);
  }

  countIndexJobs(): number {
    return Number(this.rows('SELECT COUNT(*) AS n FROM index_jobs')[0]?.n ?? 0);
  }
}
