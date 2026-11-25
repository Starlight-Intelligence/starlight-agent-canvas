# World Canvas MCP Tool Contract (as the client sees it)

Status: written by lane L5 on 2026-11-25 for issue #63. It mirrors L2's server on branch `agent/claude-cloud/world-edge` at commit 161c054 (`apps/world-edge/src/tools.ts`, `mcp.ts`, `world-agent.ts`, `region.ts`, `indexing.ts`, `store.ts`). L2's code is the authority for the server; spec section 8 names the tools but not the exact shapes. If L2 changes a shape, `@starlight-agent-canvas/world-agents` must change with it, because the client validates every result.

The client's copy of this contract is `packages/world-agents/src/client/tools.ts` (`WORLD_TOOLS`). Entity schemas (`WorldNode`, `WorldEdge`, `World`, `Actor`, ops) are L1's, from `packages/world`.

## Transport

- MCP Streamable HTTP, JSON-RPC 2.0, `POST /mcp`. L2's handler (`createMcpHandler` from the Agents SDK) is stateless and sends no `Mcp-Session-Id`; the client works with or without one.
- Auth: `Authorization: Bearer <service token>` (see [connect-agents.md](./connect-agents.md)). A 401 body is `{error: {code: "UNAUTHENTICATED", message}}`.
- The client sends `initialize` (protocol version `2025-11-25`, then whatever version the server negotiates), `notifications/initialized`, then `tools/call`. It accepts `application/json` or `text/event-stream` responses.
- The server URL must be https (http only for `localhost`, `127.0.0.1` or `[::1]`) and must have no query string or fragment.
- Redirects are never followed. Each request times out after 30 seconds by default (`timeoutMs`). On HTTP 404 after a session started, the client re-initializes once. Any other non-2xx response is a transport error carrying the status and the start of the body, with secrets removed.
- L2 returns every result as JSON in one `text` content item. The client also accepts `structuredContent` if a server sends it.

## Inputs

Every input is a strict object (unknown keys rejected) and every tool takes `worldId`.

| Tool | Input |
| --- | --- |
| `get_world` | `{worldId}` |
| `get_region` | `{worldId, regionId?, bounds?, level?, zoom?, kinds?, limit?}`: at least one of `regionId` or `bounds`; `level` is `cluster`, `card` or `full` (server default `card`, or derived from `zoom`); `kinds` NodeKind[]; `limit` 1..5000 |
| `search` | `{worldId, query (1..500), kinds?, limit? (1..50, server default 20)}` |
| `add_node` | `{worldId, node}`: L1's `nodeInputSchema` with `id` optional (the server makes one with `newId('n', title)`); `regionId` is inside `node` |
| `update_node` | `{worldId, id, baseVersion, patch}` with L1's `nodePatchSchema` |
| `link` | `{worldId, from, to, relation, label?}` (the client also rejects `from` equal to `to`, which L1's op rejects anyway) |
| `move` | `{worldId, moves: [{id, baseVersion, position, regionId?}]}` (1..5000) |
| `propose_canon` | `{worldId, title (1..300), targets: [{type: "node" or "edge", id, baseVersion}] (1..100), rationale (1..2000)}`; no status and no `ref` |
| `layout_region` | `{worldId, regionId, strategy: "grid", "layered" or "force"}` |
| `import_whiteboard` | `{worldId, whiteboard, lexicon?: {kinds?: Record<string, NodeKind>, tags?: Record<string, string[]>}, title?, dryRun?}`; only seeds an empty world |

## Outputs

Unknown extra keys on objects are ignored, so additive server fields are safe.

| Tool | Output |
| --- | --- |
| `get_world` | `{world: World, counts: {nodes, edges, nodesByKind: Record<string, int>, edgesByRelation: Record<string, int>}, openProposals}` |
| `get_region` | `{ok: true, version, level, bounds, regions, clusters: [{tile, count, byKind, center: {x, y}}], nodes, edges, truncated}` |
| `search` | `{mode: "semantic", "d1-like" or "do-like", hits: [{id, kind, title, summary, position, regionId, score?}]}` |
| `add_node`, `update_node`, `link`, `move` | WriteResult: `{ok: true, version, seq, nodes: WorldNode[], edges: WorldEdge[], removedNodes, removedEdges, proposals: CanonProposal[]}` |
| `propose_canon` | WriteResult plus `proposalId` |
| `layout_region` | WriteResult plus `moved` (a count) |
| `import_whiteboard` | `{ok: true, version, seq, report}`, or with `dryRun` `{ok: true, dryRun: true, report}` |

`version` on a result is the world version after the call. `get_world` carries it as `world.version`; `search` carries none.

`get_region` by level: `cluster` returns per-tile `clusters` and empty `nodes` and `edges`; `card` returns node cards (`{id, kind, title, tags, position, size?, regionId, layer, canon, version, thumbnail?}`) and edge summaries (`{id, from, to, relation, label?, canon, version}`); `full` returns whole `WorldNode` and `WorldEdge` objects. Cards carry `version`, so agents can take `baseVersion` from them, but they have no `summary` or `body`: read at `full` before editing text. If `truncated` is true, more nodes matched than `limit`.

`propose_canon` does not open a PR. It marks the targets `proposed` and stores a proposal row (`{id, title, nodeIds, edgeIds, rationale, status: "open", prUrl: null, worldVersion, harness, actor, createdAt}`, readable at `GET /agents/world-agent/<worldId>/proposals?status=open`). `canonProposalRequestFromRow` in `world-agents` turns such a row into input for `openCanonPr`, which opens the draft PR.

## Errors

A tool failure is a result with `isError: true` whose JSON text is:

```json
{ "ok": false, "version": 12, "error": { "code": "STALE_VERSION", "message": "...", "opIndex": 0, "id": "n_x", "expectedVersion": 3, "actualVersion": 4 } }
```

The client throws `WorldToolError` with `code`, `message`, the optional `opIndex`, `id`, `expectedVersion`, `actualVersion`, and `worldVersion` from the top-level `version`. `isStale` is true for `STALE_VERSION`.

Codes seen in L2: L1's `OpErrorCode` values (`INVALID_OP`, `INVALID_CONTEXT`, `NOT_FOUND`, `DUPLICATE_ID`, `STALE_VERSION`, `CANON_FORBIDDEN`, `CANON_LOCKED`, `INVALID_REFERENCE`) plus `INVALID_INPUT` and `BOUNDS_TOO_LARGE` from `get_region`. The client also understands a flat `{code, message, ...}` payload, a JSON-RPC `error` whose `data` is that flat shape, and a plain-text `CODE: message` when `CODE` is one of the codes above or `UNAUTHORIZED` (a text error carries no version details).

HTTP 401 and 403 throw `WorldAuthError`.

## Differences from spec section 8 worth a decision (L1 and L2)

- `search` returns no world version and `get_world` has it only inside `world`; spec 8 says every tool response includes it.
- `propose_canon` takes `title`, `targets` and `rationale` and opens no PR; spec 8 lists `target, baseVersion, note` and a PR URL.
- `import_whiteboard` requires `worldId` and only seeds an empty world; spec 8 says it writes a new world or a draft branch.
- `add_node` accepts `canon: {status: "proposed"}` (L1's `nodeInputSchema` allows it), which marks a node proposed without a proposal row, so it never reaches the PR flow (spec 3.5).
- Error codes for bad input differ by tool (`INVALID_INPUT` in `get_region`, `INVALID_OP` elsewhere), and importing into a non-empty world returns `DUPLICATE_ID`.
- Moving the tool schemas into `packages/world` would let the server and this client import one definition instead of keeping two copies in step.
