# Follow-up spec for L2: OAuth so ChatGPT can connect

Status: proposed by lane L5 on 2026-11-25 for issue #63. Owner: lane L2 (`apps/world-edge`). Nothing here is built yet. L5 did not change any L2 file.

## Why

L2's current design puts Cloudflare Access in front of the Worker (an Access JWT, or an Access service token sent as `CF-Access-Client-Id` and `CF-Access-Client-Secret`) and checks a static bearer token in `Authorization`. Claude Code and Codex can send both, because both let the user set arbitrary headers from environment variables.

ChatGPT cannot. Its custom MCP servers support only OAuth, no authentication, or a per-tool mix of the two. OpenAI's auth guide (https://developers.openai.com/plugins/build/auth.md, read 2026-11-25) states that ChatGPT does not support machine-to-machine OAuth grants such as client credentials and cannot present custom API keys. The only credential it ever sends is an OAuth access token it obtained itself, as `Authorization: Bearer <token>`. So under the current design ChatGPT is stopped by Access, and would be rejected by the static-bearer check even past Access. "No authentication" is not acceptable for a server with write tools.

Claude.ai and Claude Desktop custom connectors have the same shape of problem: they connect from Anthropic's cloud and default to OAuth. The same work fixes them.

## Requirements

All URLs below assume one stable public origin, written `https://<host>`. Use a custom domain rather than `*.workers.dev` so `resource` and `issuer` never change.

### R1. Protected resource on `/mcp`

1. `POST /mcp` (Streamable HTTP) accepts a valid OAuth access token in `Authorization: Bearer`.
2. With no token, or an invalid one, answer `401` with
   `WWW-Authenticate: Bearer resource_metadata="https://<host>/.well-known/oauth-protected-resource", scope="world:read world:write"`.
3. Validate on every request: signature or token lookup, `iss`, `aud` equal to the `resource` value in R2 exactly, `exp` and `nbf`, and scopes. Enforce scopes in the handler; Cloudflare's securing guide says advertised required scopes are not enforced for you (https://developers.cloudflare.com/agents/model-context-protocol/guides/securing-mcp-server/, read by our research agent 2026-11-25).
4. Map the token to the `Actor` used by `applyOps` (spec 4): `harness` from the OAuth client (`chatgpt` for ChatGPT's client id, `claude` for Claude's, `codex` for Codex), `actor` from the user's stable subject. Never take harness or actor from tool arguments.

### R2. `GET /.well-known/oauth-protected-resource` (RFC 9728)

```json
{
  "resource": "https://<host>/mcp",
  "authorization_servers": ["https://<host>"],
  "scopes_supported": ["world:read", "world:write", "world:propose"]
}
```

`resource` must be exactly the URL users paste into ChatGPT, because ChatGPT sends it verbatim as the `resource` parameter.

### R3. Authorization server metadata (RFC 8414)

Serve `GET /.well-known/oauth-authorization-server` (and ideally `/.well-known/openid-configuration`) with at least:

```json
{
  "issuer": "https://<host>",
  "authorization_endpoint": "https://<host>/authorize",
  "token_endpoint": "https://<host>/token",
  "registration_endpoint": "https://<host>/register",
  "code_challenge_methods_supported": ["S256"],
  "authorization_response_iss_parameter_supported": true,
  "client_id_metadata_document_supported": true,
  "token_endpoint_auth_methods_supported": ["none", "private_key_jwt"],
  "grant_types_supported": ["authorization_code", "refresh_token"],
  "response_types_supported": ["code"],
  "scopes_supported": ["world:read", "world:write", "world:propose"]
}
```

`issuer` must be the identical string listed in R2's `authorization_servers`. OpenAI treats a server whose metadata lacks `S256` as unsupported.

### R4. Endpoints

1. `/authorize`: authorization code flow with PKCE `S256` only. Show a consent page naming the client, the scopes and the redirect host (Cloudflare's confused-deputy guidance). Return `iss` on every authorization response, success and error, exactly equal to `issuer` (RFC 9207). ChatGPT rejects a response that advertises this and then omits or mismatches `iss`.
2. `/token`: `authorization_code` and `refresh_token` grants. Bind the `resource` parameter (RFC 8707) into the token audience. Accept `none` (public client with PKCE) and `private_key_jwt`; for the latter verify the client assertion against the JWKS named in the client's metadata document.
3. `/register`: RFC 7591 dynamic client registration, as the fallback when CIMD is not chosen.
4. CIMD: accept an HTTPS URL as `client_id` and fetch it. ChatGPT uses `https://chatgpt.com/oauth/client.json` when R4.1 holds, otherwise `https://chatgpt.com/oauth/{callback_id}/client.json`. Fetching needs outbound HTTPS from the Worker.

### R5. Redirect allowlist

Allow `https://chatgpt.com/connector_platform_oauth_redirect` (the stable URI ChatGPT uses when R4.1 holds). If the stable URI is not in use, the URI is `https://chatgpt.com/connector/oauth/{callback_id}`. The exact value is shown on the ChatGPT server's management page at setup; copy it from there. Add Claude's callback (`https://claude.ai/api/mcp/auth_callback`, per Anthropic's connector docs as read by our research agent) if Claude.ai connectors should work too. Loopback redirects (`http://127.0.0.1/...`, any port) are needed only if Claude Code or Codex users switch from bearer to OAuth.

### R6. Where Cloudflare Access sits

ChatGPT's servers cannot complete an Access login or send service-token headers. So `/mcp`, `/.well-known/*`, `/authorize`, `/token`, `/register` and the IdP callback must not be gated by an Access SSO or service-token policy.

Keep Access as the identity provider instead: the documented pattern is an Access for SaaS application (OIDC) whose redirect URL is the Worker's `/callback`, with the Worker running the code flow against Access inside `/authorize` (https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/secure-mcp-servers/, last updated Nov 2, 2026, read 2026-11-25; example repo https://github.com/cloudflare/ai/tree/main/demos/remote-mcp-cf-access). Access policies still decide who may sign in. The Worker issues its own tokens to MCP clients.

Recommended implementation: `@cloudflare/workers-oauth-provider` v1, which implements the MCP authorization revision with CIMD, DCR and RFC 9207, wrapping the MCP handler (https://github.com/cloudflare/workers-oauth-provider and https://developers.cloudflare.com/agents/model-context-protocol/authorization/, both read by our research agent 2026-11-25). It needs a KV namespace (`OAUTH_KV` in the examples) and, to fetch CIMD documents, the `global_fetch_strictly_public` compatibility flag.

Not recommended without a test: Cloudflare Access "Managed OAuth" (beta, https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/, last updated Nov 3, 2026). Nobody has documented ChatGPT working through it, and Cloudflare says not to combine it with a server that runs its own OAuth.

### R7. Keep the static bearer path for local agents

Claude Code and Codex work today with the static bearer. Keep that working, choosing one of:

- (a) accept either a valid OAuth token or the static bearer on `/mcp`, checking the static token with a constant-time compare and stamping `harness` from a per-token mapping; or
- (b) serve the static-bearer path on a separate hostname or route that stays behind Access with a Service Auth policy.

Option (b) keeps the public OAuth surface free of long-lived secrets and is L5's preference. Either way, never accept the static token as an OAuth token or the reverse.

### R8. Tool annotations

Set `readOnlyHint: true` on `get_world`, `get_region` and `search`. Leave the write tools (`add_node`, `update_node`, `link`, `move`, `propose_canon`, `layout_region`, `import_whiteboard`) without `readOnlyHint`, so ChatGPT asks the user to confirm each write and Codex's `default_tools_approval_mode = "writes"` prompts for them. Return results in `structuredContent` and also as JSON text, which is what `@starlight-agent-canvas/world-agents` reads.

### R9. Secrets and config (names only, values never in git)

KV `OAUTH_KV`; secrets `ACCESS_CLIENT_ID`, `ACCESS_CLIENT_SECRET`, `ACCESS_TOKEN_URL`, `ACCESS_AUTHORIZATION_URL`, `ACCESS_JWKS_URL`, `COOKIE_ENCRYPTION_KEY` (names from Cloudflare's Access for SaaS guide). Creating these is a Cloudflare resource change and needs a human with account access.

## Acceptance tests for L2

1. `curl -i https://<host>/mcp` with no token returns 401 and the `WWW-Authenticate` header from R1.2.
2. `GET /.well-known/oauth-protected-resource` and `GET /.well-known/oauth-authorization-server` return the documents in R2 and R3, and `issuer` equals the `authorization_servers` entry.
3. MCP Inspector's auth walkthrough completes the code flow with PKCE and gets a token whose `aud` is `https://<host>/mcp`.
4. A token minted for another resource is rejected with 401.
5. ChatGPT: Plugins, Add custom MCP server, OAuth, sign in through Access, then `get_world` runs and `add_node` asks for confirmation and succeeds. The created node's `createdBy.harness` is `chatgpt`.
6. Claude Code and Codex still connect with the static bearer as described in [connect-agents.md](./connect-agents.md).
7. No tool call over OAuth or bearer can produce canon status `canon` (spec 3).

## Open questions for L2

- Which scopes gate which tools. L5 proposes `world:read` for reads, `world:write` for add, update, link, move, layout and import, and `world:propose` for `propose_canon`.
- Whether `import_whiteboard` should be allowed from ChatGPT at all, given payload size.
- Whether ChatGPT plan and workspace settings for custom MCP servers fit the people who will use this. That is unconfirmed; the OpenAI help center page on developer mode could not be read.
