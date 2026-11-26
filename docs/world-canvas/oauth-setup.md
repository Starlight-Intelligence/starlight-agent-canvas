# OAuth setup for the World Canvas MCP server (ChatGPT and claude.ai)

Status: written by lane L2b on 2026-11-26 for issue #63. It describes the OAuth support in `apps/world-edge` on branch `agent/managed/world-edge-oauth`. The acceptance contract is [chatgpt-oauth-followup.md](./chatgpt-oauth-followup.md) (lane L5). Nothing below has been run against real Cloudflare, ChatGPT or Claude accounts. Each step is marked:

- **Verified (code)**: covered by the Worker's test suite (`pnpm world-edge:test`), which runs the real Worker in workerd with a mocked Access for SaaS app and mocked client metadata documents.
- **Verified (docs)**: stated in a vendor's primary documentation, read on 2026-11-25 or 2026-11-26 (sources at the end).
- **Unverified**: not confirmed. Check it when you do the step, and fix this page if it is wrong.

Run every command from `apps/world-edge`. Commands marked "creates a resource" change your Cloudflare account; only a person with account access runs them. Secret values are typed at the `wrangler secret put` prompt and never go in a file, a command line or git.

## How it fits together

```text
ChatGPT / claude.ai servers                         Your browser
   |  1. POST /mcp, no token -> 401 + resource_metadata
   |  2. GET /.well-known/oauth-protected-resource/mcp
   |  3. GET /.well-known/oauth-authorization-server
   |  4. client id: metadata document URL (CIMD) or POST /register (DCR)
   |  5. send the user to /authorize ------------------> consent page (World Canvas)
   |                                                     Allow -> Cloudflare Access sign-in
   |                                                     (Access for SaaS app, OIDC)
   |                                                     -> /callback (Worker checks the id_token)
   |  6. <-------------------------------------------- redirect with code, state, iss
   |  7. POST /token (PKCE verifier, resource=<PUBLIC_ORIGIN>/mcp)
   |  8. POST /mcp with Authorization: Bearer <access token>
```

The Worker is its own OAuth authorization server (`@cloudflare/workers-oauth-provider` 1.4.0). Cloudflare Access is only the sign-in step inside `/authorize`, so Access policies decide who may connect. Claude Code and Codex keep using per-client bearer service tokens on the same `/mcp` URL (see [connect-agents.md](./connect-agents.md)).

## Names you will use

| Name | Kind | Value |
| --- | --- | --- |
| `<host>` | | The custom hostname for the Worker, for example `world.example.com`. Use a custom domain, not `*.workers.dev`, so the OAuth issuer and resource never change. |
| `PUBLIC_ORIGIN` | var in `wrangler.jsonc` | `https://<host>`, no path, no trailing slash |
| `OAUTH_REDIRECT_ALLOWLIST` | var in `wrangler.jsonc` | Redirect URIs that may receive a code. The default allows ChatGPT and claude.ai. |
| `OAUTH_KV` | KV namespace binding | OAuth storage |
| `ACCESS_CLIENT_ID` | secret | Client ID of the Access for SaaS app |
| `ACCESS_CLIENT_SECRET` | secret | Client secret of that app |
| `ACCESS_TOKEN_URL` | secret | Its token endpoint |
| `ACCESS_AUTHORIZATION_URL` | secret | Its authorization endpoint |
| `ACCESS_JWKS_URL` | secret | Its key endpoint |
| `MCP_SERVICE_TOKENS`, `MEDIA_SIGNING_KEY` | secrets | Already required before OAuth (see `apps/world-edge/README.md`) |

`wrangler.jsonc` lists all seven secret names under `secrets.required`, so `wrangler deploy` refuses to deploy until every one is set. No `COOKIE_ENCRYPTION_KEY` is needed (the follow-up spec listed it from Cloudflare's older demo): the library's consent and sign-in helpers keep their state in `OAUTH_KV`, bound to the browser by `__Host-` cookies. Verified (code).

## 1. Pick the hostname and route the Worker to it

1. Choose `<host>` on a zone in your Cloudflare account. It must be served on port 443; claude.ai cannot connect to a URL with another port. Verified (docs).
2. In `wrangler.jsonc`, add the custom domain and set the origin:

   ```jsonc
   "routes": [{ "pattern": "<host>", "custom_domain": true }],
   ```

   and in `vars`, replace the placeholder: `"PUBLIC_ORIGIN": "https://<host>"`. Until it is replaced, `/mcp` and the OAuth routes answer 500 (`OAUTH_MISCONFIGURED`) on purpose. Verified (code). The `custom_domain` route form is from Cloudflare's docs as quoted in the OAuth library's own guide; verified (docs).
3. With OAuth on, `/mcp` works only on `<host>`. Tokens are bound to `https://<host>/mcp`, so requests on the `workers.dev` name get 401, service tokens included. Point Claude Code and Codex at `https://<host>/mcp` too. Verified (code).

## 2. Create the OAuth storage (creates a resource)

```bash
npx wrangler kv namespace create OAUTH_KV
```

Paste the printed id into the `OAUTH_KV` entry under `kv_namespaces` in `wrangler.jsonc`, replacing the zero placeholder.

## 3. Create the Access for SaaS application (creates a resource)

In the Cloudflare dashboard. Verified (docs), except where marked.

1. **Zero Trust** > **Access controls** > **Applications** > **Create new application** > **SaaS application**.
2. **Application**: type a name such as `World Canvas MCP`, then select the text box that appears below it.
3. Choose **OIDC** as the authentication protocol, then **Add application**.
4. **Redirect URLs**: `https://<host>/callback`. Exactly this, nothing else.
5. **Scopes**: keep `openid` and `email` (the Worker needs `sub` and `email` in the ID token); `profile` is harmless. The Worker requests `openid email profile`.
6. **PKCE**: turn it on. The Worker always sends an S256 code challenge and verifier. Whether Access rejects PKCE parameters when the toggle is off is unverified, so leave it on.
7. **Flows**: keep the default (no hybrid or implicit flow). **Refresh tokens**: not needed; the Worker uses Access only once per sign-in and issues its own tokens.
8. **Access policies**: add an Allow policy for exactly the people who may connect ChatGPT or Claude to the world (for example your email or a group). Access denies everyone else. Choose the identity providers; if there is only one, **Apply instant authentication** skips the chooser.
9. Save. Copy these five values from the app page into a password manager for step 5. Do not paste them into any file or chat:
   - **Client ID**
   - **Client secret** (it may not be shown again; unverified)
   - **Token endpoint**, expected `https://<team>.cloudflareaccess.com/cdn-cgi/access/sso/oidc/<client_id>/token`
   - **Authorization endpoint**, expected `.../sso/oidc/<client_id>/authorization`
   - **Key endpoint**, expected `.../sso/oidc/<client_id>/jwks`

## 4. Check the Access app's discovery document (no credentials needed)

The Worker makes assumptions that Cloudflare's docs do not state. Check them once before you deploy:

```bash
curl -s https://<team>.cloudflareaccess.com/cdn-cgi/access/sso/oidc/<client_id>/.well-known/openid-configuration
```

| Field | The Worker needs | If it differs |
| --- | --- | --- |
| `issuer` | exactly the token endpoint without the trailing `/token` (no trailing slash) | sign-in fails closed with `access_denied`; change the issuer derivation in `src/access-oidc.ts` (`readAccessOidcConfig`) |
| `token_endpoint_auth_methods_supported` | contains `client_secret_post` | change `exchangeAccessCode` in `src/access-oidc.ts` to HTTP Basic |
| `id_token_signing_alg_values_supported` | contains `RS256` | the Worker accepts RS256 only; it would need ES256 support |
| `code_challenge_methods_supported` | contains `S256` | turn PKCE on in the app (step 3.6) |

All four are unverified until you run this. The ID token's `aud` (expected: the client ID) and whether Access echoes the `nonce` are also unverified; the Worker requires both, and a mismatch shows up as an `access_denied` redirect after a successful Access login, with the reason in the Worker's logs (`wrangler tail`, look for `OAuth sign-in refused`).

## 5. Set the secrets

Each command prompts for the value. Paste the value at the prompt only.

```bash
npx wrangler secret put ACCESS_CLIENT_ID
npx wrangler secret put ACCESS_CLIENT_SECRET
npx wrangler secret put ACCESS_TOKEN_URL
npx wrangler secret put ACCESS_AUTHORIZATION_URL
npx wrangler secret put ACCESS_JWKS_URL
# Already needed before OAuth, if not set yet:
npx wrangler secret put MCP_SERVICE_TOKENS
npx wrangler secret put MEDIA_SIGNING_KEY
```

Because `secrets.required` lists all seven names, a deploy fails until every one is set (verified (docs)). Set the secrets before the first deploy. Whether `wrangler secret put` works on a Worker that was never deployed, and how this interacts with git-connected Workers Builds, is unverified; if it refuses, deploy once with the `secrets` block removed and `PUBLIC_ORIGIN` set to `""`, set the secrets, then restore both.

The Worker refuses to start a sign-in unless `ACCESS_TOKEN_URL`, `ACCESS_AUTHORIZATION_URL` and `ACCESS_JWKS_URL` are https URLs without query or fragment and the token URL ends in `/token`. Verified (code).

## 6. Check the redirect allowlist

The default in `wrangler.jsonc`:

```text
https://chatgpt.com/connector_platform_oauth_redirect https://chatgpt.com/connector/oauth/* https://claude.ai/api/mcp/auth_callback
```

- ChatGPT uses `https://chatgpt.com/connector_platform_oauth_redirect` when the server supports RFC 9207 issuer identification, which this one does; otherwise `https://chatgpt.com/connector/oauth/{callback_id}`, covered by the `/*` entry. Verified (docs).
- claude.ai, Claude Desktop and Claude mobile use `https://claude.ai/api/mcp/auth_callback`. Verified (docs).
- Add the word `loopback` only if Claude Code or Codex users should sign in with OAuth instead of a service token. Without it they keep using bearer tokens.
- After you add the connector in ChatGPT (step 10), compare the redirect URI ChatGPT shows on the connector's management page with this list. Where ChatGPT shows it is unverified.

The list is enforced when a client registers (`/register`), on `/authorize`, and again at `/callback`. A redirect not on the list gets a local error page, never a redirect. Verified (code).

## 7. Keep Access away from the OAuth paths

ChatGPT and Claude call the Worker from their own servers and cannot pass an Access login. `/mcp`, `/.well-known/*`, `/authorize`, `/callback`, `/token` and `/register` must not sit behind any self-hosted Access application, login policy or Service Auth policy. Cloudflare's Access for SaaS guide puts no self-hosted Access application on the Worker's hostname at all. Verified (docs).

If you also want the browser UI routes behind Access, create a self-hosted Access application scoped to those paths only (`<host>/agents`, `<host>/media/sign`, `<host>/media/object`), and set `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` from it. Do not scope it to `<host>` as a whole. Whether one application can list several paths, and that a path covers its subpaths, is unverified; check the application's domain settings.

Do not use Cloudflare Access Managed OAuth for this hostname; Cloudflare says not to combine it with a server that runs its own OAuth. Verified (docs).

## 8. Deploy (Frank's decision)

```bash
npx wrangler deploy --dry-run --outdir dist   # lists bindings, uploads nothing
npx wrangler deploy
```

## 9. Smoke-test the public surface

No credentials needed:

```bash
curl -si -X POST https://<host>/mcp | sed -n '1p;/^www-authenticate/Ip'
curl -s https://<host>/.well-known/oauth-protected-resource/mcp
curl -s https://<host>/.well-known/oauth-protected-resource
curl -s https://<host>/.well-known/oauth-authorization-server
```

Expected (verified (code) against the test origin):

- `HTTP/2 401` and `www-authenticate: Bearer realm="OAuth", resource_metadata="https://<host>/.well-known/oauth-protected-resource/mcp", scope="world:read world:write"`, plus `error="invalid_token"` when a bad token was sent.
- Both protected resource documents: `"resource": "https://<host>/mcp"`, `"authorization_servers": ["https://<host>"]`, `"scopes_supported": ["world:read", "world:write"]`.
- Authorization server metadata: `"issuer": "https://<host>"` (identical to the `authorization_servers` entry), `authorization_endpoint` `/authorize`, `token_endpoint` `/token`, `registration_endpoint` `/register`, `code_challenge_methods_supported: ["S256"]`, `authorization_response_iss_parameter_supported: true`, `client_id_metadata_document_supported: true`, `token_endpoint_auth_methods_supported` including `none` and `private_key_jwt`, and `scopes_supported` with all three world scopes.
- `/.well-known/openid-configuration` answers 404. The library serves RFC 8414 metadata only, which MCP accepts.

If you see an Access login page or a 302 instead, an Access application still covers these paths (step 7).

Optional: the MCP Inspector's auth walkthrough (`npx @modelcontextprotocol/inspector`, Streamable HTTP, `https://<host>/mcp`) should complete the code flow with PKCE (acceptance test 3). Unverified.

## 10. Add the connector in ChatGPT

Verified (docs) as described by OpenAI; the live UI was not checked.

1. On ChatGPT on the web, open **Plugins** (`https://chatgpt.com/plugins`).
2. Select the **+** button, then **Add custom MCP server**.
3. Enter a name (for example `World Canvas`) and, under **Connection**, the **Server URL** `https://<host>/mcp`.
4. Authentication: **OAuth**.
5. Read the risk warning, select **I understand and want to continue**, then **Create as a plugin**.
6. Install the plugin and mention it with `@` in a chat. The first tool call starts the sign-in: our consent page names the client (ChatGPT's metadata document is published by `chatgpt.com`), the redirect host and the permissions. Tick `world:propose` as well if ChatGPT should be able to propose canon; it asks only for read and write by default. Then sign in through Access.
7. Run `get_world` for a world, then `add_node`. ChatGPT asks you to confirm the write (tools are annotated `readOnlyHint: false`). The new node's `createdBy.harness` is `chatgpt` and the ops log actor is your Access email. Verified (code) for the Worker side; the ChatGPT side is unverified.

Plans: OpenAI's pages disagree on whether Plus and Pro can add custom MCP servers; Business and Enterprise/Edu can, subject to workspace admin settings. A **Developer mode** toggle may be required depending on the account. Unverified; check your plan and workspace settings.

ChatGPT prefers the client metadata document `https://chatgpt.com/oauth/client.json`; if the builder chose dynamic registration, it registers through `/register` instead. Both map to harness `chatgpt`. Verified (code).

## 11. Add the connector in claude.ai

Verified (docs) as described by Anthropic; the live UI was not checked.

Individual plans (Free allows one custom connector):

1. **Customize** > **Connectors** (`https://claude.ai/customize/connectors`), **+ Add**, **Add custom connector**.
2. Name, then the URL `https://<host>/mcp`, **Continue**, review the detected settings, **Continue**.
3. **Authentication**: **Sign in now** or **Sign in when needed**.
4. **OAuth client**: **Use Claude's published identity (Recommended)** (client metadata document `https://claude.ai/oauth/mcp-oauth-client-metadata`) or **Register automatically** (dynamic registration). Both map to harness `claude-ai`. Do not choose **Use your own OAuth client**; this server has no pre-registered clients.
5. **Add**. In a chat, enable it under **+** > **Connectors**.

Team and Enterprise: an Owner adds it under **Organization settings** > **Connectors** > **Add** > **Custom** > **Web** with the same fields; each member then selects **Connect** under **Customize** > **Connectors**.

Claude's servers connect from `160.79.104.0/21`; nothing on the Worker restricts source IPs. Verified (docs).

## 12. Check attribution

With a service token in your environment (never on the command line):

```bash
curl -s -H "Authorization: Bearer $WORLD_CANVAS_TOKEN" "https://<host>/agents/world-agent/<worldId>/log?limit=20"
```

Rows written over OAuth show `harness` `chatgpt` or `claude-ai` and your Access email as `actor`. No tool call over OAuth or a service token can set canon status `canon` (acceptance test 7). Verified (code).

## Revoking access

- One person: remove them from the Access app's Allow policy. They cannot sign in again, but tokens already issued stay valid until they expire: access tokens after 1 hour, refresh tokens 30 days after the code exchange (the library's defaults, not changed here). Verified (docs) for the defaults.
- Everyone at once: delete and recreate the `OAUTH_KV` namespace (or remove `PUBLIC_ORIGIN` to turn OAuth off). Every client must connect again.
- A client: remove its redirect URI from `OAUTH_REDIRECT_ALLOWLIST` and deploy. New authorizations stop at once; existing tokens run out as above.

## What is verified and what is not

| Item | Status |
| --- | --- |
| 401 challenge, both protected resource documents, authorization server metadata (acceptance tests 1 and 2) | Verified (code) |
| Full code flow with PKCE for a DCR client (claude.ai callback) and the ChatGPT metadata document client, token bound to `https://<host>/mcp`, `iss` on every authorization response (acceptance test 3, mocked Access) | Verified (code) |
| Token for another resource rejected; `/token` with a foreign `resource` refused (acceptance test 4) | Verified (code) |
| Harness `chatgpt` and `claude-ai`, Access email as actor (acceptance test 5, Worker side) | Verified (code) |
| Static bearer tokens still work for Claude Code and Codex; Access JWTs never authenticate `/mcp` (acceptance test 6) | Verified (code) |
| No `canon` over OAuth or bearer (acceptance test 7) | Verified (code) |
| Redirect allowlist, id_token checks, scope per tool | Verified (code) |
| Access endpoints, dashboard steps, secret names | Verified (docs) |
| Access issuer string, token endpoint client authentication, `aud`, `nonce` echo, signing algorithm | Unverified: step 4 |
| ChatGPT and claude.ai completing the flow against a deployed Worker (acceptance test 5 end to end) | Unverified |
| ChatGPT plan gating, Developer mode, where it shows the redirect URI | Unverified |
| MCP Inspector walkthrough | Unverified |

## Sources

| Source | Used for | Read on |
| --- | --- | --- |
| `@cloudflare/workers-oauth-provider` 1.4.0 README and `docs/` (npm package) | provider behaviour, CIMD, DCR, RFC 9207, PKCE, KV, compatibility flag, token lifetimes | 2026-11-26 |
| https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/secure-mcp-servers/ | Access for SaaS for MCP servers, secret names, no Access app on the Worker host | 2026-11-26 |
| https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/saas-apps/generic-oidc-saas/ | dashboard fields, endpoint URLs, scopes, PKCE toggle | 2026-11-26 |
| https://developers.cloudflare.com/workers/wrangler/configuration/ | `secrets.required` | 2026-11-26 |
| https://developers.openai.com/plugins/build/auth.md | ChatGPT CIMD URLs, redirect URIs, RFC 9207, `resource` | 2026-11-26 |
| https://developers.openai.com/api/docs/guides/developer-mode | ChatGPT UI steps | 2026-11-26 |
| https://claude.com/docs/connectors/building/authentication | Claude CIMD and DCR, callback URL, scopes, IP range | 2026-11-26 |
| https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp and https://claude.com/docs/connectors/custom/add-unlisted.md | claude.ai UI steps, port 443 | 2026-11-26 |
| https://claude.ai/oauth/mcp-oauth-client-metadata (live document) | claude.ai client id and redirect | 2026-11-26 |
