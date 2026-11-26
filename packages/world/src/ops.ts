import { z } from 'zod';
import { edgeIdFor } from './ids.js';
import {
  actorSchema,
  entityIdSchema,
  LIMITS,
  mediaSchema,
  nodeKindSchema,
  positionSchema,
  relationSchema,
  sizeSchema,
  type Actor,
  type Canon,
  type WorldEdge,
  type WorldGraph,
  type WorldNode,
} from './schemas.js';

/**
 * Op protocol for World Graph v1.
 *
 * - Ops are strict objects: unknown keys are rejected, not stripped, so a
 *   client cannot smuggle `canon`, `version` or `createdBy` into an op.
 * - Ops that touch an existing node or edge carry `baseVersion`, the version
 *   the client last saw. A mismatch rejects the whole batch (STALE_VERSION).
 * - A batch is atomic: all ops apply or none do.
 * - No op can set canon.status to 'canon'. The most an op can do is
 *   'proposed'. Canon is promoted only by syncing merged canon from git
 *   (see promoteToCanon), never through applyOps.
 * - Identity and time come from the server-side context (`actor`), not from
 *   the op.
 */

/** canon in add ops: 'draft' or 'proposed' only. */
const opCanonInputSchema = z.strictObject({
  status: z.enum(['draft', 'proposed']),
  ref: z.url().optional(),
});

const tagsSchema = z.array(z.string().min(1).max(LIMITS.tagMax)).max(LIMITS.tagsMax);

export const nodeInputSchema = z.strictObject({
  id: entityIdSchema,
  kind: nodeKindSchema,
  title: z.string().min(1).max(LIMITS.titleMax),
  summary: z.string().max(LIMITS.summaryMax).optional(),
  body: z.string().max(LIMITS.bodyMax).optional(),
  tags: tagsSchema.optional(),
  canon: opCanonInputSchema.optional(),
  media: z.array(mediaSchema).max(LIMITS.mediaMax).optional(),
  position: positionSchema,
  size: sizeSchema.optional(),
  regionId: entityIdSchema.nullable().optional(),
  layer: z.number().int().min(-1000).max(1000).optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});
export type NodeInput = z.infer<typeof nodeInputSchema>;

/** Fields an update may change. No canon, id, worldId, version, createdBy, position. */
export const nodePatchSchema = z.strictObject({
  kind: nodeKindSchema.optional(),
  title: z.string().min(1).max(LIMITS.titleMax).optional(),
  summary: z.string().max(LIMITS.summaryMax).optional(),
  body: z.string().max(LIMITS.bodyMax).optional(),
  tags: tagsSchema.optional(),
  media: z.array(mediaSchema).max(LIMITS.mediaMax).optional(),
  size: sizeSchema.nullable().optional(),
  regionId: entityIdSchema.nullable().optional(),
  layer: z.number().int().min(-1000).max(1000).optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
}).refine((patch) => Object.values(patch).some((value) => value !== undefined), { message: 'patch must change at least one field.' });
export type NodePatch = z.infer<typeof nodePatchSchema>;

const baseVersionSchema = z.number().int().positive();

export const addNodeOpSchema = z.strictObject({
  op: z.literal('addNode'),
  node: nodeInputSchema,
});

export const updateNodeOpSchema = z.strictObject({
  op: z.literal('updateNode'),
  id: entityIdSchema,
  baseVersion: baseVersionSchema,
  patch: nodePatchSchema,
});

export const moveNodesOpSchema = z.strictObject({
  op: z.literal('moveNodes'),
  moves: z.array(z.strictObject({
    id: entityIdSchema,
    baseVersion: baseVersionSchema,
    position: positionSchema,
    regionId: entityIdSchema.nullable().optional(),
  })).min(1).max(LIMITS.movesPerOpMax),
});

export const removeNodeOpSchema = z.strictObject({
  op: z.literal('removeNode'),
  id: entityIdSchema,
  baseVersion: baseVersionSchema,
});

export const addEdgeOpSchema = z.strictObject({
  op: z.literal('addEdge'),
  edge: z.strictObject({
    /** Optional; defaults to a deterministic id from (from, relation, to). */
    id: entityIdSchema.optional(),
    from: entityIdSchema,
    to: entityIdSchema,
    relation: relationSchema,
    label: z.string().min(1).max(LIMITS.labelMax).optional(),
    canon: opCanonInputSchema.optional(),
    meta: z.record(z.string(), z.unknown()).optional(),
  }),
});

export const removeEdgeOpSchema = z.strictObject({
  op: z.literal('removeEdge'),
  id: entityIdSchema,
  baseVersion: baseVersionSchema,
});

export const proposeCanonOpSchema = z.strictObject({
  op: z.literal('proposeCanon'),
  target: z.strictObject({
    type: z.enum(['node', 'edge']),
    id: entityIdSchema,
  }),
  baseVersion: baseVersionSchema,
  /** Link to the canon PR once opened. Usually filled in by L2 after it opens the PR. */
  ref: z.url().optional(),
  /** Why this should be canon. Goes into the PR body. */
  note: z.string().max(LIMITS.summaryMax).optional(),
});

export const graphOpSchema = z.discriminatedUnion('op', [
  addNodeOpSchema,
  updateNodeOpSchema,
  moveNodesOpSchema,
  removeNodeOpSchema,
  addEdgeOpSchema,
  removeEdgeOpSchema,
  proposeCanonOpSchema,
]);
export type GraphOp = z.infer<typeof graphOpSchema>;
export type GraphOpInput = z.input<typeof graphOpSchema>;

export const graphOpBatchSchema = z.array(graphOpSchema).max(LIMITS.opsPerBatchMax);

export type OpErrorCode =
  | 'INVALID_OP'
  | 'INVALID_CONTEXT'
  | 'NOT_FOUND'
  | 'DUPLICATE_ID'
  | 'STALE_VERSION'
  | 'CANON_FORBIDDEN'
  | 'CANON_LOCKED'
  | 'INVALID_REFERENCE';

export interface OpError {
  code: OpErrorCode;
  message: string;
  /** Index of the failing op in the batch, when known. */
  opIndex?: number;
  id?: string;
  expectedVersion?: number;
  actualVersion?: number;
}

export interface CanonProposal {
  targetType: 'node' | 'edge';
  id: string;
  title: string;
  version: number;
  ref?: string;
  note?: string;
  proposedBy: Actor;
}

export interface ApplyContext {
  /** Server-stamped identity and timestamp for every change in this batch. */
  actor: Actor;
}

export type ApplyResult =
  | {
    ok: true;
    graph: WorldGraph;
    applied: number;
    changed: { nodes: string[]; edges: string[]; removedNodes: string[]; removedEdges: string[] };
    proposals: CanonProposal[];
  }
  | { ok: false; graph: WorldGraph; error: OpError };

class OpFailure extends Error {
  constructor(readonly detail: OpError) {
    super(detail.message);
  }
}

function fail(detail: OpError): never {
  throw new OpFailure(detail);
}

function checkVersion(kind: 'node' | 'edge', id: string, actual: number, expected: number, opIndex: number): void {
  if (actual !== expected) {
    fail({
      code: 'STALE_VERSION',
      message: `${kind} ${id} is at version ${actual}, op was based on ${expected}. Re-read and retry.`,
      opIndex,
      id,
      expectedVersion: expected,
      actualVersion: actual,
    });
  }
}

/**
 * The op name for an error message. Never throws: a malformed op may carry an
 * `op` that is an object without a usable toString, or no `op` at all.
 */
function describeOpName(raw: unknown): string {
  try {
    if (raw === null || typeof raw !== 'object') return '?';
    const name = (raw as Record<string, unknown>).op;
    if (typeof name === 'string') return name.length > 40 ? `${name.slice(0, 40)}…` : name;
    return name === undefined ? '?' : `<${typeof name}>`;
  } catch {
    return '?';
  }
}

function toCanon(input: { status: 'draft' | 'proposed'; ref?: string } | undefined): Canon {
  if (!input) return { status: 'draft' };
  return input.ref ? { status: input.status, ref: input.ref } : { status: input.status };
}

/**
 * Pure reducer. Returns a new graph; never mutates the input. Atomic: on any
 * error the original graph is returned with `ok: false`.
 *
 * Cost is O(nodes + edges + ops) per batch, including batches with many
 * removeNode ops (edges are indexed by endpoint once per batch): unchanged
 * node and edge objects are shared with the input, not copied.
 */
export function applyOps(graph: WorldGraph, ops: readonly unknown[], context: ApplyContext): ApplyResult {
  const actorParse = actorSchema.safeParse(context?.actor);
  if (!actorParse.success) {
    return { ok: false, graph, error: { code: 'INVALID_CONTEXT', message: `Invalid actor: ${actorParse.error.issues[0]?.message ?? 'unknown'}` } };
  }
  const actor = actorParse.data;

  // Ops usually arrive as parsed JSON from a client. Anything malformed must
  // come back as INVALID_OP, never as a thrown error.
  if (!Array.isArray(ops)) {
    return { ok: false, graph, error: { code: 'INVALID_OP', message: 'Ops must be an array.' } };
  }
  if (ops.length > LIMITS.opsPerBatchMax) {
    return { ok: false, graph, error: { code: 'INVALID_OP', message: `A batch may hold at most ${LIMITS.opsPerBatchMax} ops.` } };
  }

  const parsedOps: GraphOp[] = [];
  for (let i = 0; i < ops.length; i++) {
    let parsed: ReturnType<typeof graphOpSchema.safeParse>;
    try {
      parsed = graphOpSchema.safeParse(ops[i]);
    } catch {
      return { ok: false, graph, error: { code: 'INVALID_OP', message: `Op ${i} could not be read.`, opIndex: i } };
    }
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const opName = describeOpName(ops[i]);
      const path = issue ? issue.path.map((part) => (typeof part === 'symbol' ? '?' : String(part))) : [];
      const touchesCanon = path.includes('canon') || (issue?.code === 'unrecognized_keys' && Array.isArray((issue as { keys?: unknown }).keys) && (issue as { keys: unknown[] }).keys.includes('canon'));
      return {
        ok: false,
        graph,
        error: {
          code: touchesCanon ? 'CANON_FORBIDDEN' : 'INVALID_OP',
          message: touchesCanon
            ? `Op ${i} (${opName}) tries to set canon. Ops may only create drafts or use proposeCanon; canon is promoted from git.`
            : `Op ${i} (${opName}) is invalid at ${path.join('.') || '(root)'}: ${typeof issue?.message === 'string' ? issue.message : 'unknown'}`,
          opIndex: i,
        },
      };
    }
    parsedOps.push(parsed.data);
  }

  if (parsedOps.length === 0) {
    return { ok: true, graph, applied: 0, changed: { nodes: [], edges: [], removedNodes: [], removedEdges: [] }, proposals: [] };
  }

  const worldId = graph.world.id;
  const regionIds = new Set(graph.world.regions.map((region) => region.id));
  const nodes = new Map<string, WorldNode>(graph.nodes.map((node) => [node.id, node]));
  const edges = new Map<string, WorldEdge>(graph.edges.map((edge) => [edge.id, edge]));
  const changedNodes = new Set<string>();
  const changedEdges = new Set<string>();
  const removedNodes = new Set<string>();
  const removedEdges = new Set<string>();
  const proposals: CanonProposal[] = [];
  // Versions are never reused. A removed node or edge raises this floor to its
  // last version, and every new node or edge starts above it, so a stale op
  // that names a removed entity's old version can never match a replacement
  // created under the same id.
  let retiredVersion = graph.world.retiredVersion ?? 0;
  const retire = (version: number): void => {
    if (version > retiredVersion) retiredVersion = version;
  };
  // node id -> ids of edges touching it, so removing a node costs O(its edges)
  // rather than O(all edges). Built on first use.
  let edgesByNode: Map<string, Set<string>> | null = null;
  const indexEdge = (index: Map<string, Set<string>>, edge: WorldEdge): void => {
    for (const end of [edge.from, edge.to]) {
      let set = index.get(end);
      if (!set) index.set(end, (set = new Set()));
      set.add(edge.id);
    }
  };
  const edgeIndex = (): Map<string, Set<string>> => {
    if (!edgesByNode) {
      edgesByNode = new Map();
      for (const edge of edges.values()) indexEdge(edgesByNode, edge);
    }
    return edgesByNode;
  };
  const dropEdge = (edge: WorldEdge): void => {
    edges.delete(edge.id);
    if (edgesByNode) {
      edgesByNode.get(edge.from)?.delete(edge.id);
      edgesByNode.get(edge.to)?.delete(edge.id);
    }
    changedEdges.delete(edge.id);
    removedEdges.add(edge.id);
    retire(edge.version);
  };

  const requireRegion = (regionId: string | null | undefined, opIndex: number): void => {
    if (regionId && !regionIds.has(regionId)) {
      fail({ code: 'INVALID_REFERENCE', message: `Unknown region ${regionId}.`, opIndex, id: regionId });
    }
  };
  const requireNode = (id: string, opIndex: number): WorldNode => {
    const node = nodes.get(id);
    if (!node) fail({ code: 'NOT_FOUND', message: `Node ${id} does not exist.`, opIndex, id });
    return node;
  };
  const requireEdge = (id: string, opIndex: number): WorldEdge => {
    const edge = edges.get(id);
    if (!edge) fail({ code: 'NOT_FOUND', message: `Edge ${id} does not exist.`, opIndex, id });
    return edge;
  };

  try {
    parsedOps.forEach((op, opIndex) => {
      switch (op.op) {
        case 'addNode': {
          const input = op.node;
          if (nodes.has(input.id)) fail({ code: 'DUPLICATE_ID', message: `Node ${input.id} already exists.`, opIndex, id: input.id });
          requireRegion(input.regionId, opIndex);
          const node: WorldNode = {
            id: input.id,
            worldId,
            kind: input.kind,
            title: input.title,
            summary: input.summary ?? '',
            body: input.body ?? '',
            tags: input.tags ?? [],
            canon: toCanon(input.canon),
            media: input.media ?? [],
            position: input.position,
            ...(input.size ? { size: input.size } : {}),
            regionId: input.regionId ?? null,
            layer: input.layer ?? 0,
            createdBy: actor,
            updatedAt: actor.at,
            version: retiredVersion + 1,
            meta: input.meta ?? {},
          };
          nodes.set(node.id, node);
          removedNodes.delete(node.id);
          changedNodes.add(node.id);
          if (node.canon.status === 'proposed') {
            proposals.push({ targetType: 'node', id: node.id, title: node.title, version: node.version, ref: node.canon.ref, proposedBy: actor });
          }
          break;
        }
        case 'updateNode': {
          const node = requireNode(op.id, opIndex);
          checkVersion('node', node.id, node.version, op.baseVersion, opIndex);
          if (node.canon.status === 'canon') {
            fail({ code: 'CANON_LOCKED', message: `Node ${node.id} is canon. Change it through a canon PR, not an edit.`, opIndex, id: node.id });
          }
          requireRegion(op.patch.regionId, opIndex);
          // A direct JS caller can pass `{ title: undefined }`; zod accepts it, but
          // spreading it would erase the field. Treat undefined as "not changed".
          const patch = Object.fromEntries(Object.entries(op.patch).filter(([, value]) => value !== undefined)) as typeof op.patch;
          const { size, ...rest } = patch;
          const next: WorldNode = { ...node, ...rest, updatedAt: actor.at, version: node.version + 1 };
          if (size === null) delete next.size;
          else if (size) next.size = size;
          // An edit after a proposal makes the proposal stale; drop back to draft.
          if (node.canon.status === 'proposed') next.canon = { status: 'draft' };
          nodes.set(next.id, next);
          changedNodes.add(next.id);
          break;
        }
        case 'moveNodes': {
          const seen = new Set<string>();
          for (const move of op.moves) {
            if (seen.has(move.id)) fail({ code: 'INVALID_OP', message: `Node ${move.id} appears twice in one moveNodes op.`, opIndex, id: move.id });
            seen.add(move.id);
            const node = requireNode(move.id, opIndex);
            checkVersion('node', node.id, node.version, move.baseVersion, opIndex);
            requireRegion(move.regionId, opIndex);
            // Layout is not canon content, so canon nodes may move.
            const next: WorldNode = {
              ...node,
              position: move.position,
              ...(move.regionId !== undefined ? { regionId: move.regionId } : {}),
              updatedAt: actor.at,
              version: node.version + 1,
            };
            nodes.set(next.id, next);
            changedNodes.add(next.id);
          }
          break;
        }
        case 'removeNode': {
          const node = requireNode(op.id, opIndex);
          checkVersion('node', node.id, node.version, op.baseVersion, opIndex);
          if (node.canon.status === 'canon') {
            fail({ code: 'CANON_LOCKED', message: `Node ${node.id} is canon and cannot be removed from the canvas.`, opIndex, id: node.id });
          }
          const touching = [...(edgeIndex().get(node.id) ?? [])].map((id) => edges.get(id)!).filter(Boolean);
          for (const edge of touching) {
            if (edge.canon.status === 'canon') {
              fail({ code: 'CANON_LOCKED', message: `Node ${node.id} has canon edge ${edge.id}; remove is refused.`, opIndex, id: edge.id });
            }
          }
          for (const edge of touching) dropEdge(edge);
          edgesByNode?.delete(node.id);
          nodes.delete(node.id);
          changedNodes.delete(node.id);
          removedNodes.add(node.id);
          retire(node.version);
          break;
        }
        case 'addEdge': {
          const input = op.edge;
          if (input.from === input.to) fail({ code: 'INVALID_OP', message: 'Edges cannot connect a node to itself.', opIndex });
          requireNode(input.from, opIndex);
          requireNode(input.to, opIndex);
          const id = input.id ?? edgeIdFor(worldId, input.from, input.relation, input.to);
          if (edges.has(id)) fail({ code: 'DUPLICATE_ID', message: `Edge ${id} already exists.`, opIndex, id });
          const edge: WorldEdge = {
            id,
            worldId,
            from: input.from,
            to: input.to,
            relation: input.relation,
            ...(input.label ? { label: input.label } : {}),
            canon: toCanon(input.canon),
            createdBy: actor,
            updatedAt: actor.at,
            version: retiredVersion + 1,
            meta: input.meta ?? {},
          };
          edges.set(id, edge);
          if (edgesByNode) indexEdge(edgesByNode, edge);
          removedEdges.delete(id);
          changedEdges.add(id);
          if (edge.canon.status === 'proposed') {
            proposals.push({ targetType: 'edge', id, title: `${edge.from} ${edge.relation} ${edge.to}`, version: edge.version, ref: edge.canon.ref, proposedBy: actor });
          }
          break;
        }
        case 'removeEdge': {
          const edge = requireEdge(op.id, opIndex);
          checkVersion('edge', edge.id, edge.version, op.baseVersion, opIndex);
          if (edge.canon.status === 'canon') {
            fail({ code: 'CANON_LOCKED', message: `Edge ${edge.id} is canon and cannot be removed from the canvas.`, opIndex, id: edge.id });
          }
          dropEdge(edge);
          break;
        }
        case 'proposeCanon': {
          const { type, id } = op.target;
          const current = type === 'node' ? requireNode(id, opIndex) : requireEdge(id, opIndex);
          checkVersion(type, id, current.version, op.baseVersion, opIndex);
          if (current.canon.status === 'canon') {
            fail({ code: 'CANON_LOCKED', message: `${type} ${id} is already canon.`, opIndex, id });
          }
          const canon: Canon = op.ref ? { status: 'proposed', ref: op.ref } : { status: 'proposed' };
          const version = current.version + 1;
          if (type === 'node') {
            const node = current as WorldNode;
            nodes.set(id, { ...node, canon, updatedAt: actor.at, version });
            changedNodes.add(id);
            proposals.push({ targetType: 'node', id, title: node.title, version, ref: op.ref, note: op.note, proposedBy: actor });
          } else {
            const edge = current as WorldEdge;
            edges.set(id, { ...edge, canon, updatedAt: actor.at, version });
            changedEdges.add(id);
            proposals.push({ targetType: 'edge', id, title: `${edge.from} ${edge.relation} ${edge.to}`, version, ref: op.ref, note: op.note, proposedBy: actor });
          }
          break;
        }
      }
    });
  } catch (error) {
    if (error instanceof OpFailure) return { ok: false, graph, error: error.detail };
    throw error;
  }

  // Reconcile proposals with the final batch state: a later edit (which drops
  // the target back to draft) or a remove invalidates an earlier proposal, and
  // repeated proposals for one target collapse to the last one.
  const lastProposal = new Map<string, CanonProposal>();
  for (const proposal of proposals) lastProposal.set(`${proposal.targetType}:${proposal.id}`, proposal);
  const liveProposals: CanonProposal[] = [];
  for (const proposal of lastProposal.values()) {
    const target = proposal.targetType === 'node' ? nodes.get(proposal.id) : edges.get(proposal.id);
    if (!target || target.canon.status !== 'proposed') continue;
    liveProposals.push(target.version === proposal.version ? proposal : { ...proposal, version: target.version });
  }

  return {
    ok: true,
    graph: {
      schemaVersion: graph.schemaVersion,
      world: {
        ...graph.world,
        version: graph.world.version + 1,
        updatedAt: actor.at,
        ...(retiredVersion > 0 ? { retiredVersion } : {}),
      },
      nodes: [...nodes.values()],
      edges: [...edges.values()],
    },
    applied: parsedOps.length,
    changed: {
      nodes: [...changedNodes],
      edges: [...changedEdges],
      removedNodes: [...removedNodes],
      removedEdges: [...removedEdges],
    },
    proposals: liveProposals,
  };
}

/**
 * Privileged canon sync. Marks a node or edge as canon after its canon PR has
 * merged in git. `ref` must link to the merged source. This is deliberately
 * not an op: it must never be reachable from an MCP tool or the browser. L2
 * calls it only from the git sync path.
 */
export function promoteToCanon(
  graph: WorldGraph,
  target: { type: 'node' | 'edge'; id: string },
  ref: string,
  actor: Actor,
): WorldGraph {
  const refCheck = z.url({ protocol: /^https$/ }).safeParse(ref);
  if (!refCheck.success) throw new Error('promoteToCanon requires an https ref to the merged canon source.');
  const stamp = actorSchema.parse(actor);
  const canon: Canon = { status: 'canon', ref };
  if (target.type === 'node') {
    let found = false;
    const nodes = graph.nodes.map((node) => {
      if (node.id !== target.id) return node;
      found = true;
      return { ...node, canon, updatedAt: stamp.at, version: node.version + 1 };
    });
    if (!found) throw new Error(`Node ${target.id} does not exist.`);
    return { ...graph, world: { ...graph.world, version: graph.world.version + 1, updatedAt: stamp.at }, nodes };
  }
  let found = false;
  const edges = graph.edges.map((edge) => {
    if (edge.id !== target.id) return edge;
    found = true;
    return { ...edge, canon, updatedAt: stamp.at, version: edge.version + 1 };
  });
  if (!found) throw new Error(`Edge ${target.id} does not exist.`);
  return { ...graph, world: { ...graph.world, version: graph.world.version + 1, updatedAt: stamp.at }, edges };
}
