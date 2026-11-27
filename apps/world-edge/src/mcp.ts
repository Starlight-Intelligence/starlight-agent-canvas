import { McpServer } from '@modelcontextprotocol/server';
import { importClaudeWhiteboard, newId, type WorldNode } from '@starlight-agent-canvas/world';
import { getAgentByName } from 'agents';
import { createMcpHandler } from 'agents/mcp/server';
import type { z } from 'zod';
import { canAccessWorld, type Principal } from './auth.js';
import type { Env } from './env.js';
import { d1Search, semanticSearch, toHit, type SearchHit, type SearchMode } from './indexing.js';
import { TOOL_INPUTS } from './tools.js';
import type { WriteResult } from './world-agent.js';

export const MCP_ROUTE = '/mcp';

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

function ok(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

function errorResult(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], isError: true };
}

/** Write results carry ok: false with the spec error (STALE_VERSION details included). */
function fromWrite(result: { ok: boolean }): ToolResult {
  return result.ok ? ok(result) : errorResult(result);
}

const READ = { readOnlyHint: true, destructiveHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false } as const;

/**
 * The World MCP server for one authenticated caller. Built per request so
 * the principal is a plain closure value; every write passes it to the
 * WorldAgent, which stamps it into the ops_log. No tool can remove content,
 * write canon, or call GitHub.
 */
export function buildWorldMcpServer(env: Env, principal: Principal): McpServer {
  const server = new McpServer({ name: 'starlight-world', version: '0.1.0' });
  const authorize = (worldId: string) => {
    if (!canAccessWorld(principal, worldId)) {
      throw new Error(JSON.stringify({ code: 'WORLD_FORBIDDEN', message: `This credential is not authorized for world "${worldId}".` }));
    }
  };
  const world = (worldId: string) => {
    authorize(worldId);
    return getAgentByName(env.WorldAgent, worldId);
  };

  server.registerTool('get_world', {
    description: 'World record (title, version, regions) with node counts by kind and edge counts by relation.',
    inputSchema: TOOL_INPUTS.get_world,
    annotations: READ,
  }, async ({ worldId }) => ok(await (await world(worldId)).getWorldInfo()));

  server.registerTool('get_region', {
    description: 'Nodes and edges inside a region or bounds at a semantic zoom level. cluster returns per-tile counts only. Never returns the whole world.',
    inputSchema: TOOL_INPUTS.get_region,
    annotations: READ,
  }, async ({ worldId, ...query }) => {
    const result = await (await world(worldId)).getRegion(query);
    return result.ok ? ok(result) : errorResult(result);
  });

  server.registerTool('search', {
    description: 'Ranked search over node titles and summaries. Semantic (Vectorize) when available, text match otherwise. Returns ids with positions.',
    inputSchema: TOOL_INPUTS.search,
    annotations: READ,
  }, async ({ worldId, query, kinds, limit }) => {
    authorize(worldId);
    return ok(await searchWorld(env, worldId, query, kinds, limit ?? 20));
  });

  server.registerTool('add_node', {
    description: 'Create a draft node. canon may be draft or proposed, never canon. id is generated when omitted.',
    inputSchema: TOOL_INPUTS.add_node,
    annotations: WRITE,
  }, async ({ worldId, node }) => {
    const withId = { ...node, id: node.id ?? newId('n', node.title) };
    return fromWrite(await (await world(worldId)).applyBatch([{ op: 'addNode', node: withId }], principal, 'mcp:add_node'));
  });

  server.registerTool('update_node', {
    description: 'Patch a node. baseVersion must equal the current version or the call fails with STALE_VERSION. Editing a proposed node returns it to draft.',
    inputSchema: TOOL_INPUTS.update_node,
    annotations: WRITE,
  }, async ({ worldId, id, baseVersion, patch }) =>
    fromWrite(await (await world(worldId)).applyBatch([{ op: 'updateNode', id, baseVersion, patch }], principal, 'mcp:update_node')));

  server.registerTool('link', {
    description: 'Create a typed edge between two nodes. Linking the same pair and relation twice fails with DUPLICATE_ID.',
    inputSchema: TOOL_INPUTS.link,
    annotations: WRITE,
  }, async ({ worldId, from, to, relation, label }) =>
    fromWrite(await (await world(worldId)).applyBatch([{ op: 'addEdge', edge: { from, to, relation, ...(label ? { label } : {}) } }], principal, 'mcp:link')));

  server.registerTool('move', {
    description: 'Move nodes. Each move carries the node baseVersion. Canon nodes may move; layout is not canon.',
    inputSchema: TOOL_INPUTS.move,
    annotations: { ...WRITE, idempotentHint: true },
  }, async ({ worldId, moves }) =>
    fromWrite(await (await world(worldId)).applyBatch([{ op: 'moveNodes', moves }], principal, 'mcp:move')));

  server.registerTool('propose_canon', {
    description: 'Mark nodes or edges as proposed and record a canon proposal (title, targets, rationale) for review. Does not write canon and does not open a PR; a later git flow does that.',
    inputSchema: TOOL_INPUTS.propose_canon,
    annotations: WRITE,
  }, async ({ worldId, ...proposal }) => fromWrite(await (await world(worldId)).proposeCanon(proposal, principal)));

  server.registerTool('layout_region', {
    description: 'Lay out the nodes of one region (grid, layered, or force) and apply the result as moves. At most 1000 nodes per call; larger regions return truncated: true with total and a message.',
    inputSchema: TOOL_INPUTS.layout_region,
    annotations: WRITE,
  }, async ({ worldId, regionId, strategy }) => fromWrite(await (await world(worldId)).layoutRegion(regionId, strategy, principal)));

  server.registerTool('import_whiteboard', {
    description: 'Import a claude.ai whiteboard export into an empty world. Everything lands as draft. Use dryRun to see the report first.',
    inputSchema: TOOL_INPUTS.import_whiteboard,
    annotations: WRITE,
  }, async ({ worldId, whiteboard, lexicon, title, dryRun }) => {
    authorize(worldId);
    let imported: ReturnType<typeof importClaudeWhiteboard>;
    try {
      imported = importClaudeWhiteboard(whiteboard, { worldId, ...(title ? { title } : {}), ...(lexicon ? { lexicon } : {}), at: new Date().toISOString() });
    } catch (error) {
      return errorResult({ ok: false, error: { code: 'INVALID_OP', message: error instanceof Error ? error.message : String(error) } });
    }
    if (dryRun) return ok({ ok: true, dryRun: true, report: imported.report });
    const result = (await (await world(worldId)).importGraph(imported.graph, principal)) as WriteResult;
    return result.ok
      ? ok({ ok: true, version: result.version, seq: result.seq, report: imported.report })
      : errorResult({ ...result, report: imported.report });
  });

  return server;
}

/**
 * Search with graceful degradation: Vectorize + Workers AI, then D1 LIKE,
 * then the Durable Object's own LIKE search. Each step falls through on a
 * missing binding, an error, or (semantic only) an empty result.
 */
export async function searchWorld(
  env: Env,
  worldId: string,
  query: string,
  kinds: readonly string[] | undefined,
  limit: number,
): Promise<{ mode: SearchMode; hits: SearchHit[] }> {
  const agent = await getAgentByName(env.WorldAgent, worldId);
  try {
    const semantic = await semanticSearch(env, worldId, query, limit * 2, kinds);
    if (semantic) {
      const nodes = (await agent.getNodesById(semantic.map((m) => m.nodeId))) as WorldNode[];
      const byId = new Map(nodes.map((n) => [n.id, n]));
      const hits = semantic
        .map((m) => (byId.has(m.nodeId) ? toHit(byId.get(m.nodeId)!, m.score) : null))
        .filter((h): h is SearchHit => h !== null && (!kinds || kinds.length === 0 || kinds.includes(h.kind)))
        .slice(0, limit);
      // Vectorize can lag behind writes or miss a world entirely; an empty
      // semantic answer falls through to text search.
      if (hits.length > 0) return { mode: 'semantic', hits };
    }
  } catch (error) {
    console.warn('world-edge: semantic search failed, falling back', String(error));
  }
  try {
    const d1 = await d1Search(env, worldId, query, kinds, limit);
    if (d1) return { mode: 'd1-like', hits: d1 };
  } catch (error) {
    console.warn('world-edge: D1 search failed, falling back to the Durable Object', String(error));
  }
  return { mode: 'do-like', hits: (await agent.searchLocal(query, kinds ? [...kinds] : undefined, limit)) as SearchHit[] };
}

/** Handle one /mcp request for an authenticated principal. */
export function handleMcp(request: Request, env: Env, ctx: ExecutionContext, principal: Principal): Promise<Response> {
  const handler = createMcpHandler(() => buildWorldMcpServer(env, principal), { route: MCP_ROUTE });
  return handler(request, env, ctx);
}

export type ToolInput<K extends keyof typeof TOOL_INPUTS> = z.infer<(typeof TOOL_INPUTS)[K]>;
