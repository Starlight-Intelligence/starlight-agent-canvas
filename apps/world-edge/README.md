# world-edge

Cloudflare Worker for the World Canvas (issue #63, lane L2). One Durable Object per world holds the World Graph from `@starlight-agent-canvas/world`, applies GraphOps through its `applyOps`, keeps an append-only ops log, and broadcasts diffs to every connected browser and agent. The same Worker serves an MCP endpoint at `/mcp` so Claude, Codex and ChatGPT edit the same graph.

Nothing in this directory deploys itself. The first deploy, the Cloudflare Access policy and any custom domain are Frank's decision.

## Architecture

```text
 Browser (canvas UI, L3)          MCP clients (Claude, Codex, ChatGPT)
   | Access cookie                   | Authorization: Bearer <service token>
   | Cf-Access-Jwt-Assertion         |
   v                                 v
 +--------------------------------------------------------------------+
 | Worker  src/index.ts                                               |
 |  1. drop any client x-world-principal header                       |
 |  2. authenticate:                                                  |
 |     /mcp: bearer service token only (hash in MCP_SERVICE_TOKENS);  |
 |           Access JWTs are ignored                                  |
 |     other routes: bearer service token, or a browser Access        |
 |           identity JWT with email (RS256, team certs, AUD check);  |
 |           Access service-token JWTs are rejected                   |
 |  3. route:                                                         |
 |     /mcp            -> createMcpHandler (agents/mcp/server) with   |
 |                        tools from src/mcp.ts, principal in closure |
 |     /agents/world-agent/<worldId>[/...]                            |
 |                     -> routeAgentRequest (HTTP and WebSocket),     |
 |                        principal in x-world-principal              |
 |     /media/sign, /media/upload, /media/object/<key> -> R2          |
 +--------------------------------------------------------------------+
        | DO RPC (getAgentByName)          | waitUntil after commit
        v                                  v
 +---------------------------------+   +-------------------------------+
 | WorldAgent (Agent, SQLite DO)   |   | D1 WORLD_INDEX                |
 | name = worldId                  |   |  worlds, world_nodes          |
 | tables: world_meta, regions,    |   |  (tile_key, kind, title, xy)  |
 |   nodes, edges, ops_log,        |   | Vectorize WORLD_VECTORS       |
 |   canon_proposals               |   |  + Workers AI embeddings      |
 | write path:                     |   |  (title + summary)            |
 |   load subgraph for the batch   |   +-------------------------------+
 |   -> applyOps (L1, pure)        |
 |   -> commit + ops_log in one    |   R2 WORLD_MEDIA: images and
 |      SQLite transaction         |   manuscripts, signed uploads
 |   -> broadcast world.diff       |
 |   -> setState(small summary)    |
 +---------------------------------+
```

### Write path

1. A client sends a batch of GraphOps (MCP tool, WebSocket message, or `POST /agents/world-agent/<worldId>/ops`).
2. `WorldAgent` loads only what the batch needs: all regions, every node and edge the ops name, the deterministic id an `addEdge` would get, and the edges around a removed node. That subgraph goes through L1 `applyOps`, which owns every rule: strict op schemas, `STALE_VERSION`, `CANON_FORBIDDEN`, `CANON_LOCKED`, `DUPLICATE_ID`. A test checks that the subgraph gives the same answer as `applyOps` on the full graph.
3. On success, changed rows, the new world version and one `ops_log` row (harness, actor, ops, changed ids, prior JSON of every touched entity) are written in one SQLite transaction. On failure nothing is written and the caller gets the spec error, including `expectedVersion` and `actualVersion` for stale writes (HTTP 409).
4. The agent broadcasts a `world.diff` message with the changed entities, updates its small synced state (version, counts, last change), and mirrors changed nodes into D1 and Vectorize through `waitUntil`. The DO stays the source of truth; the index can be rebuilt from it.

### Canon

Canon is never written here. `applyOps` refuses `canon` in any op, `importGraph` refuses imported canon, and there is no call to `promoteToCanon`. `propose_canon` sets targets to `proposed` through `proposeCanon` ops and inserts a `canon_proposals` row (title, node ids, edge ids, rationale, harness). Turning that row into a draft PR against arcanea-ai-app is a later lane; this Worker never calls GitHub.

### Region loading at 100k+ nodes

- Nodes carry `tile_key` (`floor(x/2048):floor(y/2048)`, spec section 6), `x`, `y`, `w`, `h`, `region_id` and `kind` columns with indexes on tile, region, position and kind.
- `get_region(bounds | regionId, level | zoom)` reads only the tiles that overlap the bounds (padded one tile up and left so nodes that start outside still show), then filters exact box overlap in SQL.
  - `cluster` (zoom below 0.4): per-tile counts by kind and the mean position. No nodes.
  - `card`: id, kind, title, tags, position, size, canon, version and one thumbnail. No body.
  - `full`: complete nodes.
- Limits: at most 1024 tiles per query (`BOUNDS_TOO_LARGE` otherwise), 2000 nodes by default and 5000 at most, with `truncated: true` when cut. Edges come back when either end is in the result.
- Id lists go to SQLite as one JSON parameter through `json_each`, so no query hits the bound-parameter limit.
- The synced Agent state never contains nodes. Clients fetch regions and apply diffs.

## Bindings

| Binding | Type | Purpose | Required |
| --- | --- | --- | --- |
| `WorldAgent` | Durable Object (SQLite) | One instance per world, name = world id | yes |
| `WORLD_INDEX` | D1 | Cross-world index: `worlds`, `world_nodes` (tile, kind, title, summary, position) | no; search falls back to the DO |
| `WORLD_MEDIA` | R2 | Images and manuscripts under `worlds/<worldId>/media/` | no; media routes return 503 |
| `WORLD_VECTORS` | Vectorize (768 dims, cosine) | Semantic search over node title + summary, namespace = world id | no; search falls back to D1 LIKE |
| `AI` | Workers AI | Embeddings with `@cf/baai/bge-base-en-v1.5` | no; as above |
| `ACCESS_TEAM_DOMAIN` | var | `https://<team>.cloudflareaccess.com` | for browsers |
| `ACCESS_AUD` | var | Access application AUD tag | for browsers |
| `MCP_SERVICE_TOKENS` | secret | JSON array of `{name, harness, sha256}` for MCP clients | for MCP |
| `MEDIA_SIGNING_KEY` | secret | HMAC key for signed upload URLs | for uploads |

`wrangler.jsonc` sets `workers_dev: true` and `preview_urls: false`. The D1 id, bucket name and index name are placeholders.

## Routes

| Route | Auth | Notes |
| --- | --- | --- |
| `GET /health` | none | liveness |
| `POST /mcp` | bearer only | MCP (stateless Streamable HTTP, Agents SDK `createMcpHandler`) |
| `GET /agents/world-agent/<worldId>` | bearer or Access | world record and counts; WebSocket upgrade for live sync |
| `GET /agents/world-agent/<worldId>/region?x&y&w&h&level` | bearer or Access | same as `get_region` |
| `POST /agents/world-agent/<worldId>/ops` | bearer or Access | `{ops: GraphOp[]}`; 409 on `STALE_VERSION` |
| `GET /agents/world-agent/<worldId>/log?after&limit` | bearer or Access | ops log |
| `GET /agents/world-agent/<worldId>/proposals?status=open` | bearer or Access | canon proposals |
| `POST /media/sign` | bearer or Access | `{worldId, filename, contentType}` gives a 15 minute PUT URL |
| `PUT /media/upload?...` | signed URL | write-once; content type and uploader are bound into the signature |
| `GET /media/object/<key>` | bearer or Access | read media |

`bearer` is a per-client service token from `MCP_SERVICE_TOKENS`. `/mcp` takes only that token. It never reads `Cf-Access-Jwt-Assertion`, so an Access JWT of any kind does not authenticate it, and a missing or wrong bearer token gets 401. On the other routes, `Access` means a browser identity JWT with an `email` claim, which maps to harness `human` with the email as actor. A JWT that Access issues for an Access service token (`CF-Access-Client-Id` and `CF-Access-Client-Secret`) has no email and is rejected everywhere.

WebSocket messages from the server: `world.hello` (on connect), `world.diff` (after every accepted batch), plus the Agents SDK state frame with the small summary. Messages to the server: `{id, type: "ops", ops}`, `{id, type: "get_region", query}`, `{id, type: "get_world"}`; replies are `{id, type: "result", result}`. Clients cannot set Agent state directly.

## MCP tools

All tools take `worldId`, validate input with zod schemas built from `packages/world` (`src/tools.ts`), write through `WorldAgent`, and record the caller's harness and token name in the ops log. No tool removes content or writes canon.

| Tool | Writes | Notes |
| --- | --- | --- |
| `get_world` | no | world record, regions, counts by kind and relation |
| `get_region` | no | region or bounds at a zoom level |
| `search` | no | `mode` says which path answered: `semantic`, `d1-like` or `do-like` |
| `add_node` | yes | id generated with `newId('n', title)` when omitted |
| `update_node` | yes | needs `baseVersion` |
| `link` | yes | deterministic edge id, so linking twice is `DUPLICATE_ID` |
| `move` | yes | each move carries `baseVersion` |
| `propose_canon` | yes | `{title, targets: [{type, id, baseVersion}], rationale}`; sets `proposed`, records a proposal row |
| `layout_region` | yes | `grid`, `layered` or `force` inside the region bounds, applied as one `moveNodes` |
| `import_whiteboard` | yes | claude.ai whiteboard export into an empty world, all draft; `dryRun` returns the report only |

## Local dev

```bash
pnpm install
pnpm world-edge:test          # builds packages/world, then runs the Workers test suite
pnpm world-edge:dry-run       # bundles with wrangler, no upload
```

To run the Worker locally, create `apps/world-edge/.dev.vars` (listed in `apps/world-edge/.gitignore`; never commit it) with a local token hash:

```bash
TOKEN=$(openssl rand -hex 24)
HASH=$(printf %s "$TOKEN" | sha256sum | cut -d' ' -f1)
printf 'MCP_SERVICE_TOKENS=[{"name":"local","harness":"claude","sha256":"%s"}]\nMEDIA_SIGNING_KEY=%s\n' "$HASH" "$(openssl rand -hex 32)" > apps/world-edge/.dev.vars
pnpm --filter @starlight-agent-canvas/world-edge exec wrangler d1 migrations apply world-index --local
pnpm world-edge:dev
# then: Authorization: Bearer $TOKEN against http://localhost:8787/mcp
```

Locally, Workers AI and Vectorize are not emulated, so search uses D1 (or the DO) text matching.

## DEPLOY

Frank runs these. Nothing here has been run by an agent, and no Cloudflare resources exist yet.

```bash
cd apps/world-edge

# 1. Resources (prints ids; paste the D1 database_id into wrangler.jsonc)
npx wrangler d1 create world-index
npx wrangler r2 bucket create world-media
npx wrangler vectorize create world-vectors --dimensions=768 --metric=cosine
npx wrangler vectorize create-metadata-index world-vectors --propertyName=kind --type=string

# 2. D1 schema
npx wrangler d1 migrations apply world-index --remote

# 3. Access (dashboard): Zero Trust > Access > Applications > Self-hosted,
#    domain world-edge.<account>.workers.dev. Copy the AUD tag and team domain
#    into ACCESS_AUD and ACCESS_TEAM_DOMAIN in wrangler.jsonc.
#    Add a Bypass rule for /mcp. That is the expected setup: /mcp takes only
#    a per-client bearer token and ignores Access JWTs. An Access Service Auth
#    policy on /mcp does not give a caller any access by itself, because the
#    Worker never accepts the JWT Access adds for an Access service token.
#    Add a Bypass rule for /media/upload too if uploads come from clients
#    without an Access session; the signed URL is its credential.

# 4. Secrets (values never go in git)
npx wrangler secret put MCP_SERVICE_TOKENS   # [{"name":"claude-frank","harness":"claude","sha256":"..."}, ...]
npx wrangler secret put MEDIA_SIGNING_KEY    # openssl rand -hex 32

# 5. Deploy (first deploy is Frank's call)
npx wrangler deploy --dry-run --outdir dist   # check bindings
npx wrangler deploy
```

If a custom domain is added later, pass `allowedHostnames` and `allowedOriginHostnames` to `createMcpHandler` in `src/mcp.ts`. Its default Host and Origin checks only cover localhost and the `workers.dev` hostname.

Make one service token per client so the ops log shows who wrote what:

```bash
TOKEN=$(openssl rand -hex 32)                      # give this to the client
printf %s "$TOKEN" | sha256sum | cut -d' ' -f1     # put this hash in MCP_SERVICE_TOKENS
```

Use `harness` values `claude`, `codex` and `chatgpt` (lowercase slugs, see the spec).

### Connecting agents

The MCP URL is `https://world-edge.<account>.workers.dev/mcp`.

Keep each client's token in an environment variable (`WORLD_CANVAS_TOKEN`) and only ever write the variable name into a config file. The full, sourced instructions are in [`docs/world-canvas/connect-agents.md`](../../docs/world-canvas/connect-agents.md) (written by lane L5 on branch `agent/managed/world-agents`).

- Claude Code: add the server to `.mcp.json` by hand with the header `"Authorization": "Bearer ${WORLD_CANVAS_TOKEN}"`, exactly as in the "Project config" example in connect-agents.md, then check the file. Claude Code expands `${WORLD_CANVAS_TOKEN}` when it connects, so the token itself never lands in the file. Do not pass the token to `claude mcp add --header` (with a literal token or a double-quoted `$WORLD_CANVAS_TOKEN`): the CLI then stores the token in plain text in `~/.claude.json` or `.mcp.json`.
- Codex: in `~/.codex/config.toml`, add `[mcp_servers.starlight-world]` with `url = "https://world-edge.<account>.workers.dev/mcp"` and `bearer_token_env_var = "WORLD_CANVAS_TOKEN"`, as in connect-agents.md. The token stays in the environment.
- ChatGPT: custom connectors for remote MCP expect OAuth. A static bearer token is not enough there. Options: put the Worker behind Access with an OAuth-capable identity provider and use the Agents SDK `OAuthProvider` pattern (`@cloudflare/workers-oauth-provider`), or run ChatGPT through a bridge that injects the token. This is not built in this lane; see "Not done" in the PR.

## Not done in this lane

- Undo. `ops_log.before` stores the prior JSON of every touched entity so inverse ops can be computed; there is no undo endpoint yet.
- PR flow for canon proposals (rows wait in `canon_proposals` with `status = 'open'`).
- OAuth for ChatGPT connectors.
- Region ops (v1 spec has none) and imports into non-empty worlds.
- D1 FTS5; D1 search is `LIKE` over title and summary.
