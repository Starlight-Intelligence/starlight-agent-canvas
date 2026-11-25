# World Canvas MCP Tool Contract (client side, proposed)

Status: proposed by lane L5 on 2026-11-25 for issue #63. Spec section 8 names the tools and their rough inputs but not the exact argument nesting, the output shapes or the error envelope. `@starlight-agent-canvas/world-agents` needs all three to validate responses, so this page states what the client sends and accepts. L2 (the server) and L1 (the spec owner) should confirm it or change it; until then a server that answers differently will fail the client's output validation.

The source of truth for this page is `packages/world-agents/src/client/tools.ts` (`WORLD_TOOLS`). Entity schemas (`WorldNode`, `WorldEdge`, `World`, `Actor`) are L1's, from `packages/world/src/schemas.ts`.

## Transport

- MCP Streamable HTTP, JSON-RPC 2.0, `POST` to the server URL. The client sends `initialize` (protocol version `2025-11-25`, then whatever version the server negotiates), `notifications/initialized`, then `tools/call`. It echoes `Mcp-Session-Id` and accepts `application/json` or `text/event-stream` responses.
- The server URL must be https (http only for `localhost`, `127.0.0.1` or `[::1]`) and must have no query string or fragment.
- Redirects are never followed. A 3xx response is an error.
- Each request times out after 30 seconds by default (`timeoutMs`).
- On HTTP 404 after a session started, the client re-initializes once and retries. Any other non-2xx response is a transport error carrying the status and the start of the body, with secrets removed.
- A tool result's payload is read from `structuredContent`, or else from the first `text` content item parsed as JSON. Servers should send both.

## Inputs

Every input is a strict object: unknown keys are rejected. Every tool takes `worldId` except `import_whiteboard`, where omitting it means "create a new world".

| Tool | Input |
| --- | --- |
| `get_world` | `{worldId}` |
| `get_region` | `{worldId, regionId?, bounds?, level?}`, exactly one of `regionId` or `bounds`; `level` is `cluster`, `card` or `full` |
| `search` | `{worldId, query (1..500 chars), kinds? (NodeKind[], at least 1), limit? (1..100)}` |
| `add_node` | `{worldId, node}` where `node` is L1's `nodeInputSchema` with `id` optional; `regionId` is inside `node` |
| `update_node` | `{worldId, id, baseVersion, patch}` with L1's `nodePatchSchema` |
| `link` | `{worldId, from, to, relation, label?}`, `from` differs from `to` |
| `move` | `{worldId, moves: [{id, baseVersion, position, regionId?}]}` (1..5000) |
| `propose_canon` | `{worldId, target: {type: 'node' or 'edge', id}, baseVersion, note (1..2000)}`; no `ref` and no status |
| `layout_region` | `{worldId, regionId, strategy: 'grid', 'layered' or 'force'}` |
| `import_whiteboard` | `{worldId?, whiteboard, lexicon?: {kinds?: Record<string, NodeKind>, tags?: Record<string, string[]>}}` |

## Outputs

Every success payload includes `worldVersion` (integer, 0 or more), except that it is optional for `import_whiteboard`. Unknown extra keys on objects are ignored, so additive object fields are safe. Count maps (`counts.nodes`, `counts.edges`, `clusters[].counts`) and enum values (`kind`, `relation`, `level`) are checked against L1's lists, so a server that adds a new NodeKind or Relation breaks this client until L1 and the client are updated together.

| Tool | Output |
| --- | --- |
| `get_world` | `{world: World, counts: {nodes: {[NodeKind]: int}, edges: {[Relation]: int}}, worldVersion}` (counts may omit kinds with zero) |
| `get_region` | `{level, nodes: WorldNode[], edges: WorldEdge[], clusters?: [{tileKey: "<x>:<y>", counts: {[NodeKind]: int}}], worldVersion}` |
| `search` | `{results: [{id, kind, title, summary, position, regionId (nullable), score?}], worldVersion}` |
| `add_node` | `{node: WorldNode, worldVersion}` |
| `update_node` | `{node: WorldNode, worldVersion}` |
| `link` | `{edge: WorldEdge, worldVersion}` |
| `move` | `{nodes: WorldNode[], worldVersion}` |
| `propose_canon` | `{proposal: CanonProposal, prUrl? (https), worldVersion}` where `CanonProposal` mirrors L1's interface: `{targetType, id, title, version, ref?, note?, proposedBy: Actor}` |
| `layout_region` | `{moved: WorldNode[], worldVersion}` |
| `import_whiteboard` | `{report, worldId, worldVersion?, branch?}` |

`nodes` and `edges` are always present. At `cluster` level they may be empty and `clusters` carries the counts. Nodes returned at `card` or `full` level are full `WorldNode` objects, so they carry `version`, which agents use as `baseVersion`. A server may leave `summary` and `body` empty at `card` level (the schema defaults them to `""`), so read at `full` level before editing a node's text.

## Errors

A tool failure is a tool result with `isError: true`. The client reads the error from the payload (structured or JSON text), in either of these shapes:

```json
{ "error": { "code": "STALE_VERSION", "message": "...", "opIndex": 0, "id": "n_x", "expectedVersion": 3, "actualVersion": 4 } }
```

```json
{ "code": "STALE_VERSION", "message": "...", "id": "n_x", "expectedVersion": 3, "actualVersion": 4 }
```

In these structured shapes `code` may be any non-empty string; L1's `OpErrorCode` values are `INVALID_OP`, `INVALID_CONTEXT`, `NOT_FOUND`, `DUPLICATE_ID`, `STALE_VERSION`, `CANON_FORBIDDEN`, `CANON_LOCKED` and `INVALID_REFERENCE`. Servers should use the first (nested) shape.

Fallbacks, in order of preference for a server: a JSON-RPC `error` whose `data` is the flat (second) shape is mapped the same way; a `data` holding the nested shape is not unwrapped and becomes code `RPC_ERROR`. A plain-text error of the form `CODE: message` keeps `CODE` only when it is exactly one of the eight `OpErrorCode` values or `UNAUTHORIZED` (upper case); any other text becomes code `TOOL_ERROR` with the text as the message. A text error never carries `opIndex`, `id`, `expectedVersion` or `actualVersion`, so a server must use a structured shape for `STALE_VERSION` if agents are to see the versions.

HTTP 401 and 403 mean the credentials were rejected.

## Requests to L1 and L2

- L2: confirm or change the shapes above, return `structuredContent` plus JSON text, and use the first error shape.
- Differences from spec section 8 that need a decision: `worldId` is on every tool input (the spec rows for `update_node`, `link`, `move` and `propose_canon` omit it) and optional on `import_whiteboard`; `add_node` nests `regionId` inside `node` (the spec lists it beside the node input); `propose_canon` requires `note` (1..2000) where the op's `note` is optional; the `query`, `limit` and `level` bounds are not in the spec.
- L1: consider moving these tool schemas into `packages/world` (for example `packages/world/src/tools.ts`) so the server and the client import one definition. `world-agents` would then re-export them.
