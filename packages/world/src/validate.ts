import { worldGraphSchema, type WorldGraph } from './schemas.js';

export type GraphIssueCode =
  | 'SCHEMA'
  | 'DUPLICATE_ID'
  | 'WORLD_MISMATCH'
  | 'MISSING_REGION'
  | 'DANGLING_EDGE';

export interface GraphIssue {
  code: GraphIssueCode;
  message: string;
  path?: string;
  id?: string;
}

export type ValidationResult =
  | { ok: true; graph: WorldGraph; issues: [] }
  | { ok: false; graph?: WorldGraph; issues: GraphIssue[] };

/**
 * Referential checks the zod schema cannot express on its own:
 * unique ids, worldId agreement, regions exist, edge endpoints exist.
 */
export function findGraphIssues(graph: WorldGraph): GraphIssue[] {
  const issues: GraphIssue[] = [];
  const worldId = graph.world.id;

  const regionIds = new Set<string>();
  for (const region of graph.world.regions) {
    if (regionIds.has(region.id)) {
      issues.push({ code: 'DUPLICATE_ID', message: `Duplicate region id ${region.id}.`, id: region.id });
    }
    regionIds.add(region.id);
  }

  const nodeIds = new Set<string>();
  graph.nodes.forEach((node, index) => {
    if (nodeIds.has(node.id)) {
      issues.push({ code: 'DUPLICATE_ID', message: `Duplicate node id ${node.id}.`, id: node.id, path: `nodes.${index}` });
    }
    nodeIds.add(node.id);
    if (node.worldId !== worldId) {
      issues.push({ code: 'WORLD_MISMATCH', message: `Node ${node.id} has worldId ${node.worldId}, expected ${worldId}.`, id: node.id, path: `nodes.${index}.worldId` });
    }
    if (node.regionId !== null && !regionIds.has(node.regionId)) {
      issues.push({ code: 'MISSING_REGION', message: `Node ${node.id} points at unknown region ${node.regionId}.`, id: node.id, path: `nodes.${index}.regionId` });
    }
  });

  const edgeIds = new Set<string>();
  graph.edges.forEach((edge, index) => {
    if (edgeIds.has(edge.id)) {
      issues.push({ code: 'DUPLICATE_ID', message: `Duplicate edge id ${edge.id}.`, id: edge.id, path: `edges.${index}` });
    }
    edgeIds.add(edge.id);
    if (edge.worldId !== worldId) {
      issues.push({ code: 'WORLD_MISMATCH', message: `Edge ${edge.id} has worldId ${edge.worldId}, expected ${worldId}.`, id: edge.id, path: `edges.${index}.worldId` });
    }
    if (!nodeIds.has(edge.from)) {
      issues.push({ code: 'DANGLING_EDGE', message: `Edge ${edge.id} starts at unknown node ${edge.from}.`, id: edge.id, path: `edges.${index}.from` });
    }
    if (!nodeIds.has(edge.to)) {
      issues.push({ code: 'DANGLING_EDGE', message: `Edge ${edge.id} ends at unknown node ${edge.to}.`, id: edge.id, path: `edges.${index}.to` });
    }
  });

  return issues;
}

/** Schema parse plus referential checks. Never throws. */
export function validateWorldGraph(input: unknown): ValidationResult {
  const parsed = worldGraphSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => ({
        code: 'SCHEMA' as const,
        message: issue.message,
        path: issue.path.join('.'),
      })),
    };
  }
  const issues = findGraphIssues(parsed.data);
  if (issues.length > 0) return { ok: false, graph: parsed.data, issues };
  return { ok: true, graph: parsed.data, issues: [] };
}

export class WorldGraphValidationError extends Error {
  readonly issues: GraphIssue[];
  constructor(issues: GraphIssue[]) {
    const head = issues.slice(0, 5).map((issue) => `${issue.code}${issue.path ? ` at ${issue.path}` : ''}: ${issue.message}`).join('; ');
    super(`Invalid world graph (${issues.length} issue${issues.length === 1 ? '' : 's'}): ${head}`);
    this.name = 'WorldGraphValidationError';
    this.issues = issues;
  }
}

/** Like validateWorldGraph but throws WorldGraphValidationError. */
export function parseWorldGraph(input: unknown): WorldGraph {
  const result = validateWorldGraph(input);
  if (!result.ok) throw new WorldGraphValidationError(result.issues);
  return result.graph;
}
