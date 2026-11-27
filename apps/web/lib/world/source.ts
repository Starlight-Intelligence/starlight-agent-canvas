import type {
  Actor,
  ApplyResult,
  Bounds,
  CanonProposal,
  NodeKind,
  OpError,
  SemanticZoomLevel,
  World,
  WorldEdge,
  WorldNode,
} from '@starlight-agent-canvas/world';

/**
 * WorldSource is the only way the canvas reads or writes a world.
 *
 * The canvas never holds a whole large world. It asks for the tiles that cover
 * the padded viewport (spec section 6) and, at cluster zoom, for per-region
 * counts instead of nodes. Writes are GraphOp batches; the source applies them
 * optimistically through `applyOps` and confirms or rolls back.
 */
export interface WorldSource {
  readonly kind: 'local' | 'remote';
  /** World record (title, version, regions). Small; always loaded in full. */
  loadWorld(): Promise<WorldSummary>;
  /** Nodes and edges for the given tiles. Edges come with a tile when either endpoint is in it. */
  getTiles(tileKeys: readonly string[]): Promise<TileBatch>;
  /** Per-region counts by kind, for the cluster level. */
  getClusters(): Promise<RegionCluster[]>;
  /** Region read by id or bounds, mirroring the L2 `get_region` tool. */
  getRegion(query: RegionQuery): Promise<TileBatch>;
  /** Title search. Returns ids with positions so the canvas can jump, then load tiles there. */
  search(query: string, limit?: number): Promise<SearchHit[]>;
  /** One node by id, from cache or the backend. */
  getNode(id: string): Promise<WorldNode | null>;
  /** Neighborhood of a node up to `depth` hops, for the graph view focus. */
  getNeighborhood(id: string, depth: number): Promise<TileBatch>;
  /** Ordered story spine for the timeline view. */
  getTimeline(): Promise<TileBatch>;
  /** Apply a batch optimistically. Resolves once the backend confirms or rejects. */
  applyOps(ops: unknown[], harness?: string): Promise<OpOutcome>;
  /** Change feed: local optimistic applies, confirmations, rollbacks and remote ops. */
  subscribe(listener: (event: WorldEvent) => void): () => void;
  /** Activity so far: one entry per accepted batch, newest first. */
  activity(): ActivityEntry[];
}

export interface WorldSummary {
  world: World;
  counts: { nodes: number; edges: number; byKind: Partial<Record<NodeKind, number>> };
  /** Full-world bounds, for fit view and the minimap. */
  bounds: Bounds;
}

export interface TileBatch {
  tileKeys: string[];
  nodes: WorldNode[];
  edges: WorldEdge[];
}

export interface RegionCluster {
  regionId: string | null;
  title: string;
  bounds: Bounds;
  color: string;
  total: number;
  byKind: Partial<Record<NodeKind, number>>;
}

export type RegionQuery = { regionId: string; level?: SemanticZoomLevel } | { bounds: Bounds; level?: SemanticZoomLevel };

export interface SearchHit {
  id: string;
  kind: NodeKind;
  title: string;
  summary: string;
  position: { x: number; y: number };
  regionId: string | null;
}

export type OpOutcome =
  | { ok: true; version: number; changed: Extract<ApplyResult, { ok: true }>['changed']; proposals: CanonProposal[] }
  | { ok: false; error: OpError };

export interface ActivityEntry {
  id: string;
  harness: string;
  actor?: string;
  at: string;
  summary: string;
  ops: number;
  targetIds: string[];
  status: 'pending' | 'confirmed' | 'rejected';
  error?: string;
}

export type WorldEvent =
  | { type: 'changed'; version: number; nodeIds: string[]; edgeIds: string[]; removedNodeIds: string[]; removedEdgeIds: string[] }
  | { type: 'activity'; entry: ActivityEntry }
  | { type: 'rollback'; error: OpError };

export function actorFor(harness: string, actor?: string): Actor {
  return actor ? { harness, at: new Date().toISOString(), actor } : { harness, at: new Date().toISOString() };
}

/** One-line description of an op batch for the activity rail. Sentence case. */
export function describeOps(ops: readonly unknown[], titleOf: (id: string) => string | undefined): { summary: string; targetIds: string[] } {
  const targetIds: string[] = [];
  const parts: string[] = [];
  for (const raw of ops) {
    const op = raw as Record<string, any>;
    switch (op?.op) {
      case 'addNode':
        targetIds.push(op.node.id);
        parts.push(`Added ${op.node.kind} “${op.node.title}”`);
        break;
      case 'updateNode':
        targetIds.push(op.id);
        parts.push(`Edited ${titleOf(op.id) ?? op.id}`);
        break;
      case 'moveNodes':
        for (const m of op.moves ?? []) targetIds.push(m.id);
        parts.push(op.moves?.length === 1 ? `Moved ${titleOf(op.moves[0].id) ?? op.moves[0].id}` : `Moved ${op.moves?.length ?? 0} nodes`);
        break;
      case 'removeNode':
        targetIds.push(op.id);
        parts.push(`Removed ${titleOf(op.id) ?? op.id}`);
        break;
      case 'addEdge':
        targetIds.push(op.edge.from, op.edge.to);
        parts.push(`Linked ${titleOf(op.edge.from) ?? op.edge.from} ${op.edge.relation} ${titleOf(op.edge.to) ?? op.edge.to}`);
        break;
      case 'removeEdge':
        parts.push('Removed a link');
        break;
      case 'proposeCanon':
        targetIds.push(op.target.id);
        parts.push(`Proposed ${titleOf(op.target.id) ?? op.target.id} for canon`);
        break;
      default:
        parts.push('Unknown op');
    }
  }
  const summary = parts.length <= 2 ? parts.join('; ') : `${parts[0]} and ${parts.length - 1} more`;
  return { summary, targetIds };
}
