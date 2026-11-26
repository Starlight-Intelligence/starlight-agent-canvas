import { localhostAllowedOrigins, McpServer } from '@modelcontextprotocol/server';
import { importClaudeWhiteboard, newId, type WorldNode } from '@starlight-agent-canvas/world';
import { getAgentByName } from 'agents';
import { createMcpHandler } from 'agents/mcp/server';
import type { z } from 'zod';
import { principalScopes, type Principal, type WorldScope } from './auth.js';
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

/**
 * Tool scope gate. OAuth clients hold only the scopes they were granted;
 * advertised scopes are not enforced by the OAuth library, so every tool
 * checks here before touching anything. Service tokens hold all scopes.
 */
export const TOOL_SCOPES = {
  get_world: 'world:read',
  get_region: 'world:read',
  search: 'world:read',
  add_node: 'world:write',
  update_node: 'world:write',
  link: 'world:write',
  move: 'world:write',
  layout_region: 'world:write',
  import_whiteboard: 'world:write',
  propose_canon: 'world:propose',
} as const satisfies Record<keyof typeof TOOL_INPUTS, WorldScope>;

function insufficientScope(requiredScope: WorldScope): ToolResult {
  return errorResult({
    ok: false,
    error: { code: 'INSUFFICIENT_SCOPE', message: `This tool needs the ${requiredScope} scope, which was not granted.`, requiredScope },
  });
}

/** Wrap a tool handler so it runs only when the principal holds `scope`. */
function requireScope<A>(principal: Principal, scope: WorldScope, handler: (args: A) => Promise<ToolResult>): (args: A) => Promise<ToolResult> {
  return async (args) => (principalScopes(principal).includes(scope) ? handler(args) : insufficientScope(scope));
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
  const world = (worldId: string) => getAgentByName(env.WorldAgent, worldId);
  const scoped = <A>(tool: keyof typeof TOOL_SCOPES, handler: (args: A) => Promise<ToolResult>) =>
    requireScope(principal, TOOL_SCOPES[tool], handler);

  server.registerTool('get_world', {
    description: 'World record (title, version, regions) with node counts by kind and edge counts by relation.',
    inputSchema: TOOL_INPUTS.get_world,
    annotations: READ,
  }, scoped('get_world', async ({ worldId }) => ok(await (await world(worldId)).getWorldInfo())));

  server.registerTool('get_region', {
    description: 'Nodes and edges inside a region or bounds at a semantic zoom level. cluster returns per-tile counts only. Never returns the whole world.',
    inputSchema: TOOL_INPUTS.get_region,
    annotations: READ,
  }, scoped('get_region', async ({ worldId, ...query }) => {
    const result = await (await world(worldId)).getRegion(query);
    return result.ok ? ok(result) : errorResult(result);
  }));

  server.registerTool('search', {
    description: 'Ranked search over node titles and summaries. Semantic (Vectorize) when available, text match otherwise. Returns ids with positions.',
    inputSchema: TOOL_INPUTS.search,
    annotations: READ,
  }, scoped('search', async ({ worldId, query, kinds, limit }) => ok(await searchWorld(env, worldId, query, kinds, limit ?? 20))));

  server.registerTool('add_node', {
    description: 'Create a draft node. canon may be draft or proposed, never canon. id is generated when omitted.',
    inputSchema: TOOL_INPUTS.add_node,
    annotations: WRITE,
  }, scoped('add_node', async ({ worldId, node }) => {
    const withId = { ...node, id: node.id ?? newId('n', node.title) };
    return fromWrite(await (await world(worldId)).applyBatch([{ op: 'addNode', node: withId }], principal, 'mcp:add_node'));
  }));

  server.registerTool('update_node', {
    description: 'Patch a node. baseVersion must equal the current version or the call fails with STALE_VERSION. Editing a proposed node returns it to draft.',
    inputSchema: TOOL_INPUTS.update_node,
    annotations: WRITE,
  }, scoped('update_node', async ({ worldId, id, baseVersion, patch }) =>
    fromWrite(await (await world(worldId)).applyBatch([{ op: 'updateNode', id, baseVersion, patch }], principal, 'mcp:update_node'))));

  server.registerTool('link', {
    description: 'Create a typed edge between two nodes. Linking the same pair and relation twice fails with DUPLICATE_ID.',
    inputSchema: TOOL_INPUTS.link,
    annotations: WRITE,
  }, scoped('link', async ({ worldId, from, to, relation, label }) =>
    fromWrite(await (await world(worldId)).applyBatch([{ op: 'addEdge', edge: { from, to, relation, ...(label ? { label } : {}) } }], principal, 'mcp:link'))));

  server.registerTool('move', {
    description: 'Move nodes. Each move carries the node baseVersion. Canon nodes may move; layout is not canon.',
    inputSchema: TOOL_INPUTS.move,
    annotations: { ...WRITE, idempotentHint: true },
  }, scoped('move', async ({ worldId, moves }) =>
    fromWrite(await (await world(worldId)).applyBatch([{ op: 'moveNodes', moves }], principal, 'mcp:move'))));

  server.registerTool('propose_canon', {
    description: 'Mark nodes or edges as proposed and record a canon proposal (title, targets, rationale) for review. Does not write canon and does not open a PR; a later git flow does that.',
    inputSchema: TOOL_INPUTS.propose_canon,
    annotations: WRITE,
  }, scoped('propose_canon', async ({ worldId, ...proposal }) => fromWrite(await (await world(worldId)).proposeCanon(proposal, principal))));

  server.registerTool('layout_region', {
    description: 'Lay out the nodes of one region (grid, layered, or force) and apply the result as moves. At most 1000 nodes per call; larger regions return truncated: true with total and a message.',
    inputSchema: TOOL_INPUTS.layout_region,
    annotations: WRITE,
  }, scoped('layout_region', async ({ worldId, regionId, strategy }) => fromWrite(await (await world(worldId)).layoutRegion(regionId, strategy, principal))));

  server.registerTool('import_whiteboard', {
    description: 'Import a claude.ai whiteboard export into an empty world. Everything lands as draft. Use dryRun to see the report first.',
    inputSchema: TOOL_INPUTS.import_whiteboard,
    annotations: WRITE,
  }, scoped('import_whiteboard', async ({ worldId, whiteboard, lexicon, title, dryRun }) => {
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
  }));

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

/**
 * Origin check for createMcpHandler when the Worker has a public origin
 * (OAuth on). The handler's default Origin allowlist is localhost names plus
 * the request host on workers.dev; this keeps that and adds the public host,
 * so a browser-based MCP client on the custom domain is not refused.
 *
 * allowedHostnames (the Host check) stays at the handler's default on
 * purpose. With OAuth on, the provider accepts a token (OAuth or service
 * token) only when the request origin equals the resource origin,
 * PUBLIC_ORIGIN, so a request for any other host never reaches the handler;
 * and an explicit Host list would also refuse requests that carry no Host
 * header, which is what the Workers test harness sends.
 */
export function mcpHostOptions(requestUrl: URL, publicHost: string): { allowedOriginHostnames: string[] } {
  const workersDev = requestUrl.hostname.endsWith('.workers.dev') ? [requestUrl.hostname] : [];
  return { allowedOriginHostnames: [...new Set([publicHost, ...localhostAllowedOrigins(), ...workersDev])] };
}

/**
 * Handle one /mcp request for an authenticated principal. `publicHost` is the
 * PUBLIC_ORIGIN hostname when OAuth is on; without it the handler keeps its
 * defaults exactly as before.
 */
export function handleMcp(request: Request, env: Env, ctx: ExecutionContext, principal: Principal, publicHost?: string): Promise<Response> {
  const hostOptions = publicHost ? mcpHostOptions(new URL(request.url), publicHost) : {};
  const handler = createMcpHandler(() => buildWorldMcpServer(env, principal), { route: MCP_ROUTE, ...hostOptions });
  return handler(request, env, ctx);
}

export type ToolInput<K extends keyof typeof TOOL_INPUTS> = z.infer<(typeof TOOL_INPUTS)[K]>;
