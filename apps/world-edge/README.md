# world-edge

Cloudflare Worker for the World Canvas (issue #63, lane L2). One Durable Object per world holds the World Graph from `@starlight-agent-canvas/world`, applies GraphOps through its `applyOps`, keeps an append-only ops log, and broadcasts diffs to every connected browser and agent. The same Worker serves an MCP endpoint at `/mcp` so Claude, Codex and ChatGPT edit the same graph. Claude Code and Codex connect with a static bearer service token. ChatGPT and claude.ai custom connectors connect with OAuth 2.1: the Worker is its own authorization server and signs people in through Cloudflare Access for SaaS (OIDC).

Nothing in this directory deploys itself. The first deploy, the Cloudflare Access policy and any custom domain are Frank's decision. The step-by-step setup guide, with checks after each step, is [`docs/world-canvas/oauth-setup.md`](../../docs/world-canvas/oauth-setup.md).

## Architecture

```text
 Browser (canvas UI, L3)      Claude Code, Codex             ChatGPT, claude.ai connectors
   | Access cookie              | Bearer <service token>       | Bearer <OAuth access token>
   | Cf-Access-Jwt-Assertion    |                              | (got via /authorize, /token)
   v                            v                              v
 +----------------------------------------------------------------------------+
 | Worker  src/index.ts                                                       |
 |  1. drop any client x-world-principal header                               |
 |  2. /health, /media/upload: no further auth                                |
 |  3. OAuth on (PUBLIC_ORIGIN and OAUTH_KV set): OAuthProvider, src/oauth.ts  |
 |     /.well-known/oauth-protected-resource[/mcp]  RFC 9728 metadata         |
 |     /.well-known/oauth-authorization-server      RFC 8414 metadata         |
 |     /token, /register                            provider-owned            |
 |     /authorize, /callback   consent page, then Access for SaaS sign-in     |
 |                             (src/oauth-authorize.ts, src/access-oidc.ts)   |
 |     /mcp   token checked by the provider: an OAuth access token issued     |
 |            for <PUBLIC_ORIGIN>/mcp, or a service token through             |
 |            resolveExternalToken (hash in MCP_SERVICE_TOKENS).              |
 |            Access JWTs are never read. Tools check scopes.                 |
 |     anything else -> step 4                                                |
 |     OAuth off: OAuth paths 404, /mcp takes a service token only            |
 |  4. other routes: bearer service token, or a browser Access identity       |
 |     JWT with email (RS256, team certs, AUD check); Access service-token    |
 |     JWTs are rejected                                                      |
 |     /mcp            -> createMcpHandler (agents/mcp/server) with tools     |
 |                        from src/mcp.ts, principal in closure               |
 |     /agents/world-agent/<worldId>[/...]                                    |
 |                     -> routeAgentRequest (HTTP and WebSocket),             |
 |                        principal in x-world-principal                      |
 |     /media/sign, /media/object/<key> -> R2                                 |
 +----------------------------------------------------------------------------+
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
 |   -> broadcast world.diff       |   KV OAUTH_KV: OAuth clients,
 |   -> setState(small summary)    |   grants, hashed tokens
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
- Limits: at most 1024 tiles per query (`BOUNDS_TOO_LARGE` otherwise), 2000 nodes by default and 5000 at most, with `truncated: true` when either list is cut (`nodesTruncated` and `edgesTruncated` say which; edges cap at 20000). Edges come back when either end is in the result. Nodes larger than one tile are found through a separate partial index, so they show wherever they overlap the viewport.
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
| `OAUTH_KV` | KV namespace | OAuth provider storage: clients, grants, hashed tokens, consent and sign-in transactions | for OAuth |
| `PUBLIC_ORIGIN` | var | Public origin of the Worker, e.g. `https://world.example.com`: https, lowercase host, no port, no path, no trailing slash, nothing else (http only on `localhost`, `127.0.0.1` or `[::1]`, for local dev). It is the OAuth issuer, and the MCP resource is `<PUBLIC_ORIGIN>/mcp` | for OAuth |
| `OAUTH_REDIRECT_ALLOWLIST` | var | Redirect URIs that may receive an authorization code (see below) | for OAuth |
| `ACCESS_CLIENT_ID` | secret | Client ID of the Access for SaaS (OIDC) application | for OAuth |
| `ACCESS_CLIENT_SECRET` | secret | Client secret of that application | for OAuth |
| `ACCESS_TOKEN_URL` | secret | Its token endpoint, `https://<team>.cloudflareaccess.com/cdn-cgi/access/sso/oidc/<client_id>/token`. The id_token issuer is this URL without `/token` | for OAuth |
| `ACCESS_AUTHORIZATION_URL` | secret | Its authorization endpoint (`.../authorization`) | for OAuth |
| `ACCESS_JWKS_URL` | secret | Its key endpoint (`.../jwks`) | for OAuth |

`wrangler.jsonc` sets `workers_dev: true` and `preview_urls: false`, and the compatibility flags `nodejs_compat` and `global_fetch_strictly_public` (the OAuth library needs the second to fetch client metadata documents). The D1 id, KV id, bucket name, index name, `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` and `PUBLIC_ORIGIN` are placeholders. `secrets.required` lists every secret above, so `wrangler deploy` fails until all of them are set, and `wrangler dev` reads only those names from `.dev.vars`. No `COOKIE_ENCRYPTION_KEY` is needed: the library's consent and sign-in helpers keep their own state in `OAUTH_KV` with browser-bound cookies.

OAuth is on only when `PUBLIC_ORIGIN` and `OAUTH_KV` are both set. With `PUBLIC_ORIGIN` unset or empty, the OAuth routes answer 404 and `/mcp` takes service tokens only, as before. A `PUBLIC_ORIGIN` that is set but is not exactly an origin makes `/mcp` and the OAuth routes answer 500 (`OAUTH_MISCONFIGURED`); the placeholder value does that on purpose.

Because of `secrets.required`, the five `ACCESS_*` secrets must exist before `wrangler deploy` succeeds, even with OAuth off. With OAuth off any placeholder value works: the Worker reads them only in `/authorize` and `/callback`, which exist only with OAuth on.

Token lifetimes: an access token lasts 1 hour (`accessTokenTTL` 3600). A grant, and so its refresh tokens, ends 7 days after the client exchanges the code, a moment after sign-in (`refreshTokenTTL` 604800); refreshing does not extend it. Access is consulted only at sign-in, so someone removed from the Access policy keeps access for at most 7 days. The token response carries a refresh token whether or not the client asks for `offline_access` (this Worker does not advertise that scope). Whether ChatGPT and claude.ai use the refresh token is unverified; if one of them asks the user to sign in again about every hour, that is why. To cut that short, revoke their grants (the provider's `listUserGrants` and `revokeGrant` helpers; there is no admin route yet). Authorization codes, consent pages and sign-in transactions expire after 10 minutes. Dynamically registered clients expire after 90 days unless used.

With OAuth on, `/mcp` works only at `PUBLIC_ORIGIN`: every token, service tokens included, is bound to the resource `<PUBLIC_ORIGIN>/mcp`, and a request on another host (such as the `workers.dev` name) gets 401. Point Claude Code and Codex at the same URL.

`OAUTH_REDIRECT_ALLOWLIST` entries are separated by spaces or commas. Each is an exact https URI, an https prefix ending in `/*` that matches only deeper path segments on that exact host (no port, query, fragment or userinfo), or the word `loopback`, which allows `http://localhost[:port]/callback` and `http://127.0.0.1[:port]/callback`, optionally with one more `/<callback_id>` segment. A redirect URI containing `?` or `#` anywhere never matches. The default allows ChatGPT (`https://chatgpt.com/connector_platform_oauth_redirect`, `https://chatgpt.com/connector/oauth/*`) and claude.ai (`https://claude.ai/api/mcp/auth_callback`). Add `loopback` only if Claude Code or Codex users should sign in with OAuth instead of a service token. An empty list authorizes nothing. The list is checked when a client registers (`/register` refuses any redirect URI not on it), on `/authorize`, when consent is approved, and again at `/callback` before a code is issued.

Every client must use PKCE with `S256`, confidential DCR clients included. A request without it, or with `plain`, goes back to the client as `error=invalid_request` (with `state` and `iss`).

## Routes

| Route | Auth | Notes |
| --- | --- | --- |
| `GET /health` | none | liveness |
| `POST /mcp` | OAuth access token or bearer service token | MCP (stateless Streamable HTTP, Agents SDK `createMcpHandler`). 401 carries `WWW-Authenticate: Bearer realm="OAuth", resource_metadata="<PUBLIC_ORIGIN>/.well-known/oauth-protected-resource/mcp", scope="world:read world:write"` (plus `error="invalid_token"` for a bad token). With OAuth off: bearer service token only |
| `GET /.well-known/oauth-protected-resource/mcp` | none | RFC 9728 metadata: `resource`, `authorization_servers`, `scopes_supported` (all three scopes) |
| `GET /.well-known/oauth-protected-resource` | none | the same document |
| `GET /.well-known/oauth-authorization-server` | none | RFC 8414 metadata (issuer = `PUBLIC_ORIGIN`, S256 only, `iss` in responses, CIMD supported) |
| `GET /authorize` | none (the consent page is the gate) | validates the client, redirect and PKCE (S256), then shows the consent page. Pre-ticked scopes: the ones the client asked for, or only `world:read` if it asked for none of ours |
| `POST /authorize` | consent form, bound to the browser by a cookie | Allow: redirect to Access for SaaS sign-in. Deny: back to the client with `error=access_denied` |
| `GET /callback` | Access sign-in result, bound to the browser | checks the Access id_token, then back to the client with `code`, `state`, `iss` |
| `POST /token` | OAuth client (PKCE) | authorization code and refresh token grants, revocation |
| `POST /register` | none | RFC 7591 dynamic client registration; redirect URIs must be on the allowlist |
| `GET /agents/world-agent/<worldId>` | bearer or Access | world record and counts; WebSocket upgrade for live sync |
| `GET /agents/world-agent/<worldId>/region?x&y&w&h&level` | bearer or Access | same as `get_region` |
| `POST /agents/world-agent/<worldId>/ops` | bearer or Access | `{ops: GraphOp[]}`; 409 on `STALE_VERSION` |
| `GET /agents/world-agent/<worldId>/log?after&limit` | bearer or Access | ops log |
| `GET /agents/world-agent/<worldId>/proposals?status=open` | bearer or Access | canon proposals |
| `POST /media/sign` | bearer or Access | `{worldId, filename, contentType}` gives a 15 minute PUT URL |
| `PUT /media/upload?...` | signed URL | write-once; content type and uploader are bound into the signature |
| `GET /media/object/<key>` | bearer or Access | read media |

`bearer` is a per-client service token from `MCP_SERVICE_TOKENS`. `/mcp` takes that token or, with OAuth on, an OAuth access token this Worker issued. The provider looks up its own tokens first and passes only tokens it did not issue, and never one in its own token format, to the service-token check, so a service token is never treated as an OAuth token or the reverse. OAuth tokens are not accepted on any other route. `/mcp` never reads `Cf-Access-Jwt-Assertion`, so an Access JWT of any kind does not authenticate it, and a missing or wrong token gets 401. On the other routes, `Access` means a browser identity JWT with an `email` claim, which maps to harness `human` with the email as actor. A JWT that Access issues for an Access service token (`CF-Access-Client-Id` and `CF-Access-Client-Secret`) has no email and is rejected everywhere.

WebSocket messages from the server: `world.hello` (on connect), `world.diff` (after every accepted batch), plus the Agents SDK state frame with the small summary. Messages to the server: `{id, type: "ops", ops}`, `{id, type: "get_region", query}`, `{id, type: "get_world"}`; replies are `{id, type: "result", result}`. Clients cannot set Agent state directly.

## MCP tools

All tools take `worldId`, validate input with zod schemas built from `packages/world` (`src/tools.ts`), write through `WorldAgent`, and record the caller's harness and actor in the ops log. No tool removes content or writes canon.

Each tool needs one OAuth scope. The OAuth library advertises scopes but does not enforce them, so `src/mcp.ts` checks before the tool runs. A missing scope returns a tool error result whose JSON text is `{ok: false, error: {code: "INSUFFICIENT_SCOPE", message, requiredScope}}`, and nothing is touched. Service tokens hold all three scopes.

| Tool | Writes | Scope | Notes |
| --- | --- | --- | --- |
| `get_world` | no | `world:read` | world record, regions, counts by kind and relation |
| `get_region` | no | `world:read` | region or bounds at a zoom level |
| `search` | no | `world:read` | `mode` says which path answered: `semantic`, `d1-like` or `do-like` |
| `add_node` | yes | `world:write` | id generated with `newId('n', title)` when omitted |
| `update_node` | yes | `world:write` | needs `baseVersion` |
| `link` | yes | `world:write` | deterministic edge id, so linking twice is `DUPLICATE_ID` |
| `move` | yes | `world:write` | each move carries `baseVersion` |
| `propose_canon` | yes | `world:propose` | `{title, targets: [{type, id, baseVersion}], rationale}`; sets `proposed`, records a proposal row |
| `layout_region` | yes | `world:write` | `grid`, `layered` or `force` inside the region bounds, applied as one `moveNodes` |
| `import_whiteboard` | yes | `world:write` | claude.ai whiteboard export into an empty world, all draft; `dryRun` returns the report only |

### Who an OAuth caller is

The actor is the email from the Access id_token, the same as on the browser path. The Access `sub` is the grant's user id (and is kept in the grant), but it is not written to the ops log. That is a deliberate deviation from the follow-up spec's R1.4, which asks for the actor "from the user's stable subject": an email is what the browser path already records, and it is readable in the log. The cost is that the log cannot follow a person whose email changes.

The harness records which client identity the provider validated: the client metadata document URL (`client_id`) or the allowlisted redirect URI, computed when the code is issued (`src/harness.ts`). It cannot be set through self-asserted fields (`client_name`, tool arguments, headers). It is attribution for normal use, not a security boundary. ChatGPT and claude.ai are public clients, so anyone who may sign in through Access can register a client with their redirect URI (or present their published `client_id`), finish the flow in their own browser, read the code from the redirect and redeem it with their own PKCE verifier, and get a token labelled `chatgpt` or `claude-ai`. The authenticated identity is the actor, the Access email.

`claude-ai` and `mcp-client` are new harness slugs. The follow-up spec (R1.4) maps claude.ai to `claude`, and `docs/world-canvas/spec.md` lists the known harnesses without either slug. This branch separates claude.ai connectors (`claude-ai`) from Claude Code (`claude`) on purpose, so the list in spec.md needs updating before anything depends on it.

| Client | Harness |
| --- | --- |
| client_id `https://chatgpt.com/oauth/codex/client.json` or `https://chatgpt.com/oauth/codex/<id>/client.json` | `codex` |
| client_id `https://chatgpt.com/oauth/client.json` or `https://chatgpt.com/oauth/<id>/client.json` | `chatgpt` |
| client_id `https://claude.ai/oauth/mcp-oauth-client-metadata` | `claude-ai` |
| client_id `https://claude.ai/oauth/claude-code-client-metadata` | `claude` |
| otherwise, redirect URI `https://chatgpt.com/connector_platform_oauth_redirect` or under `https://chatgpt.com/connector/oauth/` | `chatgpt` |
| otherwise, redirect URI `https://claude.ai/api/mcp/auth_callback` | `claude-ai` |
| anything else, including any loopback redirect | `mcp-client` |

## Local dev

Prerequisites, once: run `pnpm install` from the repository root. Every command in this section runs from the repository root.

```bash
pnpm world-edge:test          # builds packages/world, then runs the Workers test suite (fully offline)
pnpm world-edge:dry-run       # bundles with wrangler, no upload
```

To run the Worker locally, create `apps/world-edge/.dev.vars` (listed in `apps/world-edge/.gitignore`; never commit it) with a local token hash:

```bash
TOKEN=$(openssl rand -hex 24)
HASH=$(printf %s "$TOKEN" | sha256sum | cut -d' ' -f1)
printf 'MCP_SERVICE_TOKENS=[{"name":"local","harness":"claude","sha256":"%s"}]\nMEDIA_SIGNING_KEY=%s\n' "$HASH" "$(openssl rand -hex 32)" > apps/world-edge/.dev.vars
pnpm --filter @starlight-agent-canvas/world-edge exec wrangler d1 migrations apply world-index --local
pnpm world-edge:dev --var PUBLIC_ORIGIN:
# then: Authorization: Bearer $TOKEN against http://localhost:8787/mcp
```

`pnpm world-edge:dev` builds `packages/world` and runs `wrangler dev`; extra arguments reach `wrangler dev`. It needs `--var PUBLIC_ORIGIN:` (or a real origin): that sets `PUBLIC_ORIGIN` to the empty string, which turns OAuth off locally, and without it the placeholder in `wrangler.jsonc` makes `/mcp` answer 500. Because `wrangler.jsonc` lists `secrets.required`, `wrangler dev` reads only those names from `.dev.vars` and warns about the Access secrets you did not set.

`wrangler dev` connects the `AI` binding to your Cloudflare account, so it needs `npx wrangler login` (or `CLOUDFLARE_API_TOKEN` in the shell), and Workers AI use is billed. Vectorize is not available locally, so search falls back to D1 (or the DO) text matching. To work fully offline, use `pnpm world-edge:test`, or run `wrangler dev -c <copy>` with a copy of `wrangler.jsonc` without the `ai` binding.

To try OAuth locally, use a separate Access for SaaS app made only for local testing, with redirect URL `http://localhost:8787/callback`. Do not write its values into `.dev.vars` or any other file. Read each one into the shell without echo and export it, for example `read -rs ACCESS_CLIENT_SECRET && export ACCESS_CLIENT_SECRET` (and the same for `ACCESS_CLIENT_ID`, `ACCESS_TOKEN_URL`, `ACCESS_AUTHORIZATION_URL`, `ACCESS_JWKS_URL`), then run `pnpm world-edge:dev --var PUBLIC_ORIGIN:http://localhost:8787` in that shell. Wrangler 4.70 and later read the names in `secrets.required` from the environment as well as from `.dev.vars` (Cloudflare's changelog); not tested here. Delete the test app when you are done. Unverified: whether Access accepts an `http://localhost` redirect URL, and whether browsers keep the library's `__Host-` cookies (which are `Secure`) on `http://localhost`. If either fails, the local try-out cannot complete; the test suite covers the flow.

## DEPLOY

Frank runs these. Nothing here has been run by an agent, and no Cloudflare resources exist yet. The same steps with a check after each one, and what is verified and what is not, are in [`docs/world-canvas/oauth-setup.md`](../../docs/world-canvas/oauth-setup.md); follow that guide for the first setup.

Prerequisites, once: from the repository root run `pnpm install`, then `npx wrangler login` (or set `CLOUDFLARE_API_TOKEN` in the shell) before any wrangler command. Steps 1 to 5 run in `apps/world-edge`; step 7 runs from the repository root.

```bash
cd apps/world-edge

# 1. Resources (prints ids; paste the D1 database_id into wrangler.jsonc)
npx wrangler d1 create world-index
npx wrangler r2 bucket create world-media
npx wrangler vectorize create world-vectors --dimensions=768 --metric=cosine
npx wrangler vectorize create-metadata-index world-vectors --propertyName=kind --type=string

# 2. D1 schema
npx wrangler d1 migrations apply world-index --remote

# 3. OAuth storage (prints an id; paste it into OAUTH_KV in wrangler.jsonc)
npx wrangler kv namespace create OAUTH_KV

# 4. Access. Two separate things:
#    a) Sign-in for OAuth clients: Zero Trust > Access controls > Applications >
#       Create new application > SaaS application > OIDC. Redirect URL:
#       <PUBLIC_ORIGIN>/callback. Copy Client ID, Client secret, Token
#       endpoint, Authorization endpoint and Key endpoint into the ACCESS_*
#       secrets below. Its Access policies decide who may sign in.
#    b) Optional, for the browser UI only: a self-hosted Access application
#       on the browser paths. Copy its AUD tag and the team domain into
#       ACCESS_AUD and ACCESS_TEAM_DOMAIN in wrangler.jsonc.
#    See "Where Access may sit" below before adding any self-hosted app.

# 5. Secrets (values never go in git). Deploy fails until every one is set.
npx wrangler secret put MCP_SERVICE_TOKENS   # [{"name":"claude-frank","harness":"claude","sha256":"..."}, ...]
npx wrangler secret put MEDIA_SIGNING_KEY    # openssl rand -hex 32
npx wrangler secret put ACCESS_CLIENT_ID
npx wrangler secret put ACCESS_CLIENT_SECRET
npx wrangler secret put ACCESS_TOKEN_URL
npx wrangler secret put ACCESS_AUTHORIZATION_URL
npx wrangler secret put ACCESS_JWKS_URL

# 6. Custom domain. In wrangler.jsonc add
#      "routes": [{ "pattern": "<host>", "custom_domain": true }]
#    and set PUBLIC_ORIGIN to "https://<host>". Check OAUTH_REDIRECT_ALLOWLIST
#    against the redirect URI ChatGPT shows on the connector's page.

# 7. From the repository root. Both scripts build packages/world first; a
#    plain `npx wrangler deploy` in apps/world-edge does not, and on a fresh
#    checkout fails with: Could not resolve "@starlight-agent-canvas/world".
cd ../..
pnpm world-edge:dry-run    # bundles and lists the bindings, no upload
pnpm world-edge:deploy     # the deploy itself: Frank's call
```

### Where Access may sit

ChatGPT and claude.ai call the Worker from their own servers. They cannot complete an Access login or send Access service-token headers. So `/mcp`, `/.well-known/*`, `/authorize`, `/callback`, `/token` and `/register` must not sit behind any Access login or Service Auth policy. Cloudflare's Access for SaaS guide puts no self-hosted Access application on the Worker's hostname at all; Access only runs the sign-in at `/authorize`. That is the simplest correct setup.

If the browser UI routes (`/agents/...`, `/media/sign`, `/media/object/...`) should sit behind a self-hosted Access application, scope that application to those paths. Access matches an application by hostname and path, so a Bypass or exclusion for the OAuth and MCP paths needs its own Access application for those paths (with a Bypass policy); a rule inside the browser application does not carve them out. An Access Service Auth policy never substitutes for the bearer or OAuth token: the Worker ignores Access JWTs on `/mcp` and rejects Access service-token JWTs everywhere.

`/media/upload` needs no Access session either; its signed URL is the credential.

With OAuth on, `src/mcp.ts` adds the `PUBLIC_ORIGIN` host to the Origin allowlist of `createMcpHandler`; its defaults (localhost names, the `workers.dev` hostname) stay. The Host check keeps its default, because the OAuth provider already refuses a token presented on any host other than `PUBLIC_ORIGIN`.

Make one service token per client so the ops log shows who wrote what:

```bash
TOKEN=$(openssl rand -hex 32)                      # give this to the client
printf %s "$TOKEN" | sha256sum | cut -d' ' -f1     # put this hash in MCP_SERVICE_TOKENS
```

Use `harness` values `claude`, `codex` and `chatgpt` (lowercase slugs, see the spec).

### Connecting agents

The MCP URL is `<PUBLIC_ORIGIN>/mcp` (with OAuth off, `https://world-edge.<account>.workers.dev/mcp` also works).

Keep each client's token in an environment variable (`WORLD_CANVAS_TOKEN`) and only ever write the variable name into a config file. The full, sourced instructions are in [`docs/world-canvas/connect-agents.md`](../../docs/world-canvas/connect-agents.md), written by lane L5 on branch `agent/managed/world-agents`; the link works once that branch is merged.

- Claude Code: add the server to `.mcp.json` by hand with the header `"Authorization": "Bearer ${WORLD_CANVAS_TOKEN}"`, as in the "Project config" example in connect-agents.md, but set `url` to `<PUBLIC_ORIGIN>/mcp`, not the `workers.dev` default shown there: with OAuth on, the `workers.dev` name answers 401 for every token. Then check the file. Claude Code expands `${WORLD_CANVAS_TOKEN}` when it connects, so the token itself never lands in the file. Do not pass the token to `claude mcp add --header` (with a literal token or a double-quoted `$WORLD_CANVAS_TOKEN`): the CLI then stores the token in plain text in `~/.claude.json` or `.mcp.json`.
- Codex: in `~/.codex/config.toml`, add `[mcp_servers.starlight-world]` with `url = "<PUBLIC_ORIGIN>/mcp"` (not the `workers.dev` URL in connect-agents.md, for the same reason) and `bearer_token_env_var = "WORLD_CANVAS_TOKEN"`. The token stays in the environment.
- ChatGPT: add a custom MCP server with the URL `<PUBLIC_ORIGIN>/mcp` and OAuth. ChatGPT finds the metadata from the 401, uses its client metadata document (`https://chatgpt.com/oauth/client.json`) or registers itself, shows our consent page, and signs the user in through Access. Its writes are recorded as harness `chatgpt` with the Access email as actor. The redirect URI ChatGPT shows on the connector's page must be on `OAUTH_REDIRECT_ALLOWLIST`.
- claude.ai and Claude Desktop: add a custom connector with the URL `<PUBLIC_ORIGIN>/mcp`. Either client option works (Claude's published identity or automatic registration); writes are recorded as harness `claude-ai`.

## Not done in this lane

- Undo. `ops_log.before` stores the prior JSON of every touched entity so inverse ops can be computed; there is no undo endpoint yet.
- PR flow for canon proposals (rows wait in `canon_proposals` with `status = 'open'`).
- No live OAuth test yet: the flows are tested against a mocked Access for SaaS app and mocked client metadata documents. Still to confirm against the real services: Access's token endpoint client authentication (the Worker sends `client_secret_post`), the literal `iss`, `aud` and `nonce` of a real Access id_token, and that ChatGPT and claude.ai complete the flow.
- No `/.well-known/openid-configuration`; the OAuth library serves RFC 8414 metadata only, which MCP accepts.
- The protected resource metadata lists all three scopes, but the OAuth library fills `scopes_supported` from the scopes it names in the 401 challenge (read and write). The Worker rewrites that one field of the library's document at both metadata locations (`src/oauth.ts`, `fetchWithOAuth`); the challenge keeps `scope="world:read world:write"`.
- No rate limiting on `/register`, `/authorize` or `/token`; both write to KV for anonymous callers. Add a Cloudflare rate-limiting rule before exposing this widely.
- No "remember this approval"; the consent page shows on every authorization.
- No scheduled `purgeExpiredData()` sweep; KV expirations remove expired records.
- Region ops (v1 spec has none) and imports into non-empty worlds.
- D1 FTS5; D1 search is `LIKE` over title and summary.
