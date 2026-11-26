# OAuth setup for the World Canvas MCP server (ChatGPT and claude.ai)

Status: written by lane L2b on 2026-11-26 for issue #63. It describes the OAuth support in `apps/world-edge` on branch `agent/managed/world-edge-oauth`. The acceptance contract is [chatgpt-oauth-followup.md](./chatgpt-oauth-followup.md) (lane L5; that file and [connect-agents.md](./connect-agents.md) live on branch `agent/managed/world-agents` until it merges, so these two links work only after both branches are merged). Nothing below has been run against real Cloudflare, ChatGPT or Claude accounts. Each claim is marked:

- **Verified (code)**: covered by a test in the Worker's suite (`pnpm world-edge:test`), which runs the real Worker in workerd with a mocked Access for SaaS app and mocked client metadata documents.
- **Verified (docs)**: stated in a vendor's primary documentation, read on 2026-11-25 or 2026-11-26 (sources at the end).
- **Unverified**: not confirmed. Check it when you do the step, and correct this page if it is wrong.

Values that come straight from `apps/world-edge/wrangler.jsonc` are marked "(wrangler.jsonc)".

Only a person with access to the Cloudflare account runs these steps; no agent deploys or creates resources. Commands marked "creates a resource" change the account. Secret values are typed at the `wrangler secret put` prompt and never go in a file, on a command line, in chat or in git.

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

The Worker is its own OAuth authorization server (`@cloudflare/workers-oauth-provider` 1.4.0). Cloudflare Access is only the sign-in step inside `/authorize`, so Access policies decide who may connect. Claude Code and Codex keep using per-client bearer service tokens on the same `/mcp` URL.

## Names you will use

| Name | Kind | Value |
| --- | --- | --- |
| `<host>` | | The custom hostname for the Worker, for example `world.example.com`. Use a custom domain, not `*.workers.dev`, so the OAuth issuer and resource never change. |
| `PUBLIC_ORIGIN` | var in `wrangler.jsonc` | `https://<host>`: lowercase host, no port, no path, no trailing slash |
| `OAUTH_REDIRECT_ALLOWLIST` | var in `wrangler.jsonc` | Redirect URIs that may receive a code. The default allows ChatGPT and claude.ai. |
| `OAUTH_KV` | KV namespace binding | OAuth storage |
| `ACCESS_CLIENT_ID` | secret | Client ID of the Access for SaaS app |
| `ACCESS_CLIENT_SECRET` | secret | Client secret of that app |
| `ACCESS_TOKEN_URL` | secret | Its token endpoint |
| `ACCESS_AUTHORIZATION_URL` | secret | Its authorization endpoint |
| `ACCESS_JWKS_URL` | secret | Its key endpoint |
| `MCP_SERVICE_TOKENS`, `MEDIA_SIGNING_KEY` | secrets | Already required before OAuth (see `apps/world-edge/README.md`) |

`secrets.required` lists all seven secret names (wrangler.jsonc), so `wrangler deploy` refuses to deploy until every one is set (verified (docs)), even with OAuth off (`PUBLIC_ORIGIN` set to `""`). With OAuth off the five `ACCESS_*` secrets are never read, so any placeholder value will do. No `COOKIE_ENCRYPTION_KEY` is needed (the follow-up spec listed it from Cloudflare's older demo): the library's consent and sign-in helpers keep their state in `OAUTH_KV`, bound to the browser by `__Host-` cookies. Verified (code): every flow test runs without such a key.

## 0. Prerequisites (once)

From the repository root, with Node 22.13 or newer and pnpm 11:

```bash
pnpm install
cd apps/world-edge && npx wrangler login && cd ../..
```

`wrangler login` opens a browser to sign in to Cloudflare. Instead, you can export `CLOUDFLARE_API_TOKEN` in your shell. Unless a step says otherwise, run `npx wrangler ...` commands from `apps/world-edge` and `pnpm ...` scripts from the repository root.

## 1. Pick the hostname and route the Worker to it

1. Choose `<host>` on a zone in your Cloudflare account. It must be served on port 443, because claude.ai cannot connect to a URL with another port. Verified (docs).
2. In `apps/world-edge/wrangler.jsonc`, add the custom domain at the top level:

   ```jsonc
   "routes": [{ "pattern": "<host>", "custom_domain": true }],
   ```

   and in `vars`, replace the placeholder: `"PUBLIC_ORIGIN": "https://<host>"`. Until it is replaced, `/mcp` and the OAuth routes answer 500 (`OAUTH_MISCONFIGURED`) on purpose. Verified (code). The `custom_domain` route form is shown in the OAuth library's guide (`docs/resource-servers.md`); Cloudflare's own page on it was not read. That a custom domain route creates the DNS record and certificate on deploy, and fails if the hostname already has a DNS record, is unverified.
3. With OAuth on, `/mcp` works only on `<host>`. Every token, service tokens included, is bound to `https://<host>/mcp`, so a request on the `workers.dev` name gets 401. Point Claude Code and Codex at `https://<host>/mcp`. Verified (code). The examples in [connect-agents.md](./connect-agents.md) (on branch `agent/managed/world-agents` until it merges) still show the `workers.dev` URL; use `https://<host>/mcp` in its place.

## 2. Create the OAuth storage (creates a resource)

```bash
npx wrangler kv namespace create OAUTH_KV
```

Put the printed id in the `OAUTH_KV` entry under `kv_namespaces` in `wrangler.jsonc`, replacing the zero placeholder. Wrangler 4.160.0 may offer to edit `wrangler.jsonc` for you; if it adds a second entry, keep one `OAUTH_KV` entry with the new id. The prompt is unverified.

## 3. Create the Access for SaaS application (creates a resource)

In the Cloudflare dashboard. Verified (docs), except where marked.

1. **Zero Trust** > **Access controls** > **Applications** > **Create new application** > **SaaS application**.
2. **Application**: type a name such as `World Canvas MCP`, then select the text box that appears below it.
3. Choose **OIDC** as the authentication protocol, then **Add application**.
4. **Redirect URLs**: `https://<host>/callback`. Exactly this, nothing else.
5. **Scopes**: keep `openid` and `email`, because the Worker needs `sub` and `email` in the ID token. `profile` is harmless. The Worker requests `openid email profile`.
6. **PKCE**: turn it on. The Worker always sends an S256 code challenge and verifier. Whether Access rejects PKCE parameters when the toggle is off is unverified, so leave it on.
7. **Flows**: keep the default (no hybrid or implicit flow). **Refresh tokens**: not needed. The Worker uses Access only once per sign-in and issues its own tokens.
8. **Access policies**: add an Allow policy for exactly the people who may connect ChatGPT or Claude to the world (for example your email or a group). Access denies everyone else. Choose the identity providers. If there is only one, **Apply instant authentication** skips the chooser. Use only identity providers that give Access an email address; a sign-in without an email ends in `access_denied`.
9. Select **Create**. Copy these five values from the app page into a password manager for step 5. Do not paste them into any file or chat:
   - **Client ID**
   - **Client secret** (it may not be shown again; unverified)
   - **Token endpoint**, expected `https://<team>.cloudflareaccess.com/cdn-cgi/access/sso/oidc/<client_id>/token`
   - **Authorization endpoint**, expected `.../sso/oidc/<client_id>/authorization`
   - **Key endpoint**, expected `.../sso/oidc/<client_id>/jwks`

## 4. Check the Access app's discovery document

The Worker makes assumptions that Cloudflare's docs do not state. Check them once before you deploy:

```bash
curl -s https://<team>.cloudflareaccess.com/cdn-cgi/access/sso/oidc/<client_id>/.well-known/openid-configuration
```

That this URL answers without signing in is unverified. If it asks you to sign in, skip this step and rely on the first test sign-in in step 10 or 11, watching `npx wrangler tail`.

| Field | The Worker needs |
| --- | --- |
| `issuer` | exactly the token endpoint without the trailing `/token`, with no trailing slash |
| `token_endpoint_auth_methods_supported` | contains `client_secret_post` |
| `id_token_signing_alg_values_supported` | contains `RS256` |
| `code_challenge_methods_supported` | contains `S256` (if it is missing, check that PKCE is on, step 3.6) |

All four are unverified until you run this. **If any of the first three differs, stop and do not deploy.** Send the output to an engineer: the Worker needs a code change (engineer's pointers: issuer derivation in `readAccessOidcConfig` and client authentication in `exchangeAccessCode`, both in `src/access-oidc.ts`; the verifier accepts RS256 only).

Also unverified: that the ID token carries the claims `sub` and `email` under those names, that its `aud` is the client ID, and that Access echoes the `nonce`. The Worker requires all of them. A mismatch shows up as an `access_denied` redirect after a successful Access login, with the reason in the Worker's logs (`npx wrangler tail`, look for `OAuth sign-in refused`).

## 5. Set the secrets (may create the Worker)

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

Set them before the first deploy, because the deploy fails until all seven exist. On a Worker that was never deployed, `wrangler secret put` offers to create it first; accept. How this interacts with git-connected Workers Builds is unverified.

The Worker refuses to start a sign-in unless `ACCESS_TOKEN_URL`, `ACCESS_AUTHORIZATION_URL` and `ACCESS_JWKS_URL` are https URLs without query or fragment and the token URL ends in `/token`. Verified (code). Watch for a trailing space when you paste: on a URL it stops the sign-in with a 503 page, and on the client ID or secret it shows up later as `access_denied`.

## 6. Check the redirect allowlist

The default (wrangler.jsonc):

```text
https://chatgpt.com/connector_platform_oauth_redirect https://chatgpt.com/connector/oauth/* https://claude.ai/api/mcp/auth_callback
```

- ChatGPT uses `https://chatgpt.com/connector_platform_oauth_redirect` when the server supports RFC 9207 issuer identification, which this one does. Otherwise it uses `https://chatgpt.com/connector/oauth/{callback_id}`, covered by the `/*` entry. Verified (docs).
- claude.ai, Claude Desktop and Claude mobile use `https://claude.ai/api/mcp/auth_callback`. Verified (docs).
- Add the word `loopback` only if Claude Code or Codex users should sign in with OAuth instead of a service token. Without it they keep using bearer tokens.
- After you add the connector in ChatGPT (step 10), compare the redirect URI ChatGPT shows on the connector's management page with this list. Where ChatGPT shows it is unverified.

The list is enforced when a client registers (`/register`), on `/authorize`, when consent is approved, and again at `/callback`. A redirect URI that is not on the list gets a local error page, never a redirect. Verified (code).

## 7. Keep Access and bot rules away from the OAuth paths

ChatGPT and Claude call the Worker from their own servers and cannot pass an Access login or a challenge.

- `/mcp`, `/.well-known/*`, `/authorize`, `/callback`, `/token` and `/register` must not sit behind any self-hosted Access application, login policy or Service Auth policy. Cloudflare's Access for SaaS guide puts no self-hosted Access application on the Worker's hostname at all. Verified (docs).
- If you also want the browser UI routes behind Access, create a self-hosted Access application scoped to those paths only (`<host>/agents`, `<host>/media/sign`, `<host>/media/object`), and set `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` from it. Do not scope it to `<host>` as a whole. Whether one application can list several paths, and whether a path covers its subpaths, is unverified; check the application's domain settings.
- Do not use Cloudflare Access Managed OAuth for this hostname. Cloudflare says not to combine it with a server that runs its own OAuth. Verified (docs).
- Make sure no Bot Fight Mode, WAF managed challenge or similar rule on the zone covers `<host>`. Unverified: whether the Worker's own fetches of `https://chatgpt.com/oauth/client.json` and `https://claude.ai/oauth/mcp-oauth-client-metadata` get through those vendors' bot protection. If the consent page says the app "could not be verified", choose **Register automatically** in Claude, or dynamic registration in ChatGPT.

## 8. Deploy (Frank's decision)

From the repository root:

```bash
pnpm world-edge:dry-run    # rebuilds packages/world, bundles, lists bindings, uploads nothing
pnpm world-edge:deploy     # rebuilds packages/world, then wrangler deploy
```

Do not run `npx wrangler deploy` directly in `apps/world-edge`: it does not rebuild `packages/world`, so it fails on a fresh checkout or uploads stale code. The dry run was run successfully on this branch by the builder and two reviewers; the deploy itself is unverified.

## 9. Smoke-test the public surface

No credentials needed:

```bash
curl -si -X POST https://<host>/mcp | grep -i -E '^(HTTP/|www-authenticate:)'
curl -s https://<host>/.well-known/oauth-protected-resource/mcp
curl -s https://<host>/.well-known/oauth-protected-resource
curl -s https://<host>/.well-known/oauth-authorization-server
```

Expected (verified (code) against the test origin):

- Status 401 and `www-authenticate: Bearer realm="OAuth", resource_metadata="https://<host>/.well-known/oauth-protected-resource/mcp", scope="world:read world:write world:propose"`. With a bad token the header also carries `error="invalid_token"`.
- Both protected resource documents include `"resource": "https://<host>/mcp"`, `"authorization_servers": ["https://<host>"]` and `"scopes_supported": ["world:read", "world:write", "world:propose"]`.
- The authorization server metadata includes `"issuer": "https://<host>"` (identical to the `authorization_servers` entry), `authorization_endpoint` `https://<host>/authorize`, `token_endpoint` `https://<host>/token`, `registration_endpoint` `https://<host>/register`, `code_challenge_methods_supported: ["S256"]`, `authorization_response_iss_parameter_supported: true`, `client_id_metadata_document_supported: true`, `token_endpoint_auth_methods_supported` containing `none` and `private_key_jwt`, and `scopes_supported` with all three world scopes.
- `/.well-known/openid-configuration` answers 404. The library serves RFC 8414 metadata only, which MCP accepts.

If you see an Access login page, a challenge page or a 302 instead, an Access application or a bot rule still covers these paths (step 7).

Optional: the MCP Inspector's auth walkthrough (Streamable HTTP, `https://<host>/mcp`) should complete the code flow with PKCE (acceptance test 3). It downloads and runs an npm package (`npx @modelcontextprotocol/inspector@<version>`), so pin a version you trust and do not run it on a machine logged in to Cloudflare. Unverified.

## 10. Add the connector in ChatGPT

Verified (docs) as described by OpenAI. The live UI was not checked.

1. On ChatGPT on the web, open **Plugins** (`https://chatgpt.com/plugins`).
2. Select the **+** button, then **Add custom MCP server**.
3. Enter a name (for example `World Canvas`) and, under **Connection**, the **Server URL** `https://<host>/mcp`.
4. Authentication: **OAuth**.
5. Read the risk warning, select **I understand and want to continue**, then **Create as a plugin**.
6. Install the plugin and mention it with `@` in a chat. The first tool call starts the sign-in. Our consent page names the client (ChatGPT's metadata document is published by `chatgpt.com`), the redirect host and the permissions.
   - Check that `world:read` and `world:write` are ticked before you select **Allow**. If only `world:read` is ticked, the client asked for none of our scopes; tick `world:write` too, or `add_node` fails with `INSUFFICIENT_SCOPE`. Which scopes ChatGPT requests is unverified.
   - Tick `world:propose` only if ChatGPT should be able to propose canon.
   - Only approve a consent page for a connection you started yourself a moment ago. Anyone can start a ChatGPT or Claude connection to this server in their own account and send you the link. If you approve it and sign in, their connector acts as you.
   - Then sign in through Access.
7. Run `get_world` for a world, then `add_node`. ChatGPT asks you to confirm the write (tools are annotated `readOnlyHint: false`). The new node's `createdBy.harness` is `chatgpt` and the ops log actor is your Access email. Verified (code) for the Worker side; the ChatGPT side is unverified.

Plans: OpenAI's pages disagree on whether Plus and Pro can add custom MCP servers. Business and Enterprise/Edu can, subject to workspace admin settings. A **Developer mode** toggle may be required depending on the account. Unverified; check your plan and workspace settings.

ChatGPT prefers its client metadata document `https://chatgpt.com/oauth/client.json`. If the plugin builder chose dynamic registration, it registers through `/register` instead. Both map to harness `chatgpt`. Verified (code).

## 11. Add the connector in claude.ai

Verified (docs) as described by Anthropic. The live UI was not checked.

Individual plans (Free allows one custom connector):

1. **Customize** > **Connectors** (`https://claude.ai/customize/connectors`), **+ Add**, **Add custom connector**.
2. Name, then the URL `https://<host>/mcp`, **Continue**, review the detected settings, **Continue**.
3. **Authentication**: **Sign in now** or **Sign in when needed**.
4. **OAuth client**: **Use Claude's published identity (Recommended)** (client metadata document `https://claude.ai/oauth/mcp-oauth-client-metadata`) or **Register automatically** (dynamic registration). Both map to harness `claude-ai`. Verified (code). Do not choose **Use your own OAuth client**; this server has no pre-registered clients.
5. **Add**. In a chat, enable it under **+** > **Connectors**. On the consent page, check the scopes as in step 10.6.

Team and Enterprise: an Owner adds it under **Organization settings** > **Connectors** > **Add** > **Custom** > **Web** with the same fields. Each member then selects **Connect** under **Customize** > **Connectors**.

Claude's servers connect from `160.79.104.0/21`. Nothing on the Worker restricts source IPs. Verified (docs).

Harness note: `claude-ai` is a new slug. The follow-up spec (R1.4) maps claude.ai to `claude`, and [spec.md](./spec.md) lists the known harnesses without `claude-ai` or `mcp-client`. This branch keeps claude.ai connectors (`claude-ai`) apart from Claude Code (`claude`) on purpose; spec.md's list needs updating before any UI depends on it.

## 12. Check attribution

With a service token in the `WORLD_CANVAS_TOKEN` environment variable. `printf` is a shell built-in, so the token never appears in a process list:

```bash
printf 'header = "Authorization: Bearer %s"\n' "$WORLD_CANVAS_TOKEN" \
  | curl -s -K - "https://<host>/agents/world-agent/<worldId>/log?after=<last seq you saw>&limit=100"
```

The log is returned oldest first from `after`. On a fresh world use `after=0`.

Rows written over OAuth show `harness` `chatgpt` or `claude-ai` and your Access email as `actor`. Verified (code).

- The actor is the authenticated identity: Access signed that person in.
- The harness records which client identity the OAuth provider validated (ChatGPT's or Claude's client metadata document, or their redirect URI). It cannot be set through anything a client asserts about itself. But it is attribution for normal use, not a security boundary. ChatGPT and Claude are public OAuth clients, so a person whom Access lets in could complete the flow under their identity in their own browser and use the token from a script. The ops log would still show that person's email.
- The follow-up spec asks for the actor to be the stable subject. This Worker uses the Access email, matching the browser routes, and keeps the Access `sub` as the grant's user id.
- No tool call over OAuth or a service token can set canon status `canon` (acceptance test 7). Verified (code).

## Token lifetimes and revoking access

Access tokens last 1 hour. The grant, with its refresh tokens, ends 7 days after the client exchanges the code (a moment after sign-in), however often it is refreshed. The token response carries a refresh token whether or not the client asks for `offline_access`. Verified (code). Whether ChatGPT and claude.ai use that refresh token is unverified; if a connector asks you to sign in again about every hour, they do not.

- One person: remove them from the Access app's Allow policy. They cannot sign in again, but their existing grant keeps working until it ends, at most 7 days later.
- Everyone at once: delete and recreate the `OAUTH_KV` namespace, or set `PUBLIC_ORIGIN` to `""` to turn OAuth off. Every client must connect again.
- A client: remove its redirect URI from `OAUTH_REDIRECT_ALLOWLIST` and deploy. New authorizations stop at once; existing grants run out as above.

## Abuse limits

`/register` and `/authorize` need no credentials (OAuth requires that), and each call writes to `OAUTH_KV`. A client metadata document URL also makes the Worker fetch it (at most 5 KB, 10 seconds). The Worker has no rate limit of its own. Add a Cloudflare rate limiting rule for `/register`, `/authorize` and `/token` on `<host>` in the zone's WAF settings. Generous limits, such as a few dozen requests per minute per IP, should not affect ChatGPT or Claude. Unverified: the dashboard path for rate limiting rules and the request rates ChatGPT's and Claude's servers stay within.

## Troubleshooting

| What you see | Likely cause |
| --- | --- |
| JSON `OAUTH_MISCONFIGURED`, status 500, on `/mcp` or `/authorize` | `PUBLIC_ORIGIN` is still the placeholder or is not exactly `https://<host>` (lowercase, no port, no path, no trailing slash) |
| Page "Sign-in is not configured on this server", status 503 | an `ACCESS_*` secret is missing, one of the three URLs has a trailing space, or `ACCESS_TOKEN_URL` does not end in `/token`. `npx wrangler tail` shows `OAuth sign-in is not configured` with the reason |
| Page saying the redirect address is not on the allowlist | add the client's redirect URI to `OAUTH_REDIRECT_ALLOWLIST` (step 6) and deploy |
| Page saying the app could not be verified | the Worker could not fetch the client's metadata document (step 7) |
| `access_denied` back in ChatGPT or Claude right after a successful Access login | the ID token failed a check (step 4). `npx wrangler tail` shows `OAuth sign-in refused` with the reason |
| `INSUFFICIENT_SCOPE` from a tool | the scope was not ticked on the consent page; disconnect and connect again |
| 401 for a service token that used to work | the client points at the `workers.dev` URL; use `https://<host>/mcp` |

## What is verified and what is not

| Item | Status |
| --- | --- |
| 401 challenge, both protected resource documents, authorization server metadata (acceptance tests 1 and 2) | Verified (code) |
| Full code flow with PKCE for the ChatGPT and claude.ai metadata document clients and for DCR clients with their redirect URIs, token bound to `https://<host>/mcp`, `iss` on every authorization response (acceptance test 3, mocked Access) | Verified (code) |
| Token for another resource rejected; `/token` with a foreign `resource` refused; service token on another host refused (acceptance test 4) | Verified (code) |
| Harness `chatgpt` and `claude-ai`, Access email as actor (acceptance test 5, Worker side) | Verified (code) |
| Static bearer tokens still work for Claude Code and Codex; Access JWTs never authenticate `/mcp` (acceptance test 6) | Verified (code) |
| No `canon` over OAuth or bearer (acceptance test 7) | Verified (code) |
| Redirect allowlist, PKCE S256 for every client, id_token checks, scope per tool, 1 hour access tokens, 7 day grants | Verified (code) |
| Access endpoints, dashboard steps, secret names, `secrets.required` blocking deploy | Verified (docs) |
| Access issuer string, token endpoint client authentication, signing algorithm, claim names, `aud`, `nonce` echo, public discovery URL | Unverified: step 4 |
| ChatGPT and claude.ai completing the flow against a deployed Worker (acceptance test 5 end to end), which scopes they request, whether they use refresh tokens | Unverified |
| ChatGPT plan gating, Developer mode, where it shows the redirect URI | Unverified |
| Custom domain DNS and certificate behaviour, wrangler prompts, rate limiting dashboard path, MCP Inspector walkthrough | Unverified |

## Sources

| Source | Used for | Read on |
| --- | --- | --- |
| `@cloudflare/workers-oauth-provider` 1.4.0 README and `docs/` (npm package) | provider behaviour, CIMD, DCR, RFC 9207, PKCE, KV, compatibility flag, token lifetimes, `custom_domain` route example | 2026-11-26 |
| https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/secure-mcp-servers/ | Access for SaaS for MCP servers, secret names, no Access app on the Worker host, no Managed OAuth | 2026-11-26 |
| https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/saas-apps/generic-oidc-saas/ | dashboard fields, endpoint URLs, scopes, PKCE toggle | 2026-11-26 |
| https://developers.cloudflare.com/workers/wrangler/configuration/ and https://developers.cloudflare.com/changelog/post/2026-03-24-secrets-config-property/ | `secrets.required` | 2026-11-26 |
| https://developers.openai.com/plugins/build/auth.md | ChatGPT CIMD URLs, redirect URIs, RFC 9207, `resource` | 2026-11-26 |
| https://developers.openai.com/api/docs/guides/developer-mode | ChatGPT UI steps | 2026-11-26 |
| https://claude.com/docs/connectors/building/authentication | Claude CIMD and DCR, callback URL, scopes, IP range | 2026-11-26 |
| https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp and https://claude.com/docs/connectors/custom/add-unlisted.md | claude.ai UI steps, port 443 | 2026-11-26 |
| https://claude.ai/oauth/mcp-oauth-client-metadata (live document) | claude.ai client id and redirect | 2026-11-26 |
