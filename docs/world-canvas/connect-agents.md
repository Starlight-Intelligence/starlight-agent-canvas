# Connect Agents to the World Canvas

Status: draft for issue #63, lane L5. Researched and written on 2026-11-25.

This page says how Claude Code, OpenAI Codex (CLI, IDE extension, desktop app, Cloud) and ChatGPT connect to the one remote World Canvas MCP server that lane L2 runs on Cloudflare Workers (`apps/world-edge`, branch `agent/claude-cloud/world-edge`, read at commit 161c054). The tool list is in [spec.md](./spec.md) section 8 and the exact arguments and results are in [tool-contract.md](./tool-contract.md). How an agent should use the tools once connected is in [`.claude/skills/world-canvas/SKILL.md`](../../.claude/skills/world-canvas/SKILL.md).

Vendor docs change often. Every claim below names its source and the date it was read. None of the vendor pages shows a "last updated" date unless one is quoted, so the date given is the date we fetched the page. Re-check any line marked "unconfirmed" before you rely on it.

## At a glance

| Client | Works with L2's auth at 161c054 (per-client bearer service token, or an Access JWT)? | Where the config lives |
| --- | --- | --- |
| Claude Code | Yes, with its own bearer token (plus Access service-token headers only if Access gates `/mcp`) | `.mcp.json` (project) or `~/.claude.json` |
| Codex CLI, IDE extension, ChatGPT desktop app | Yes, same as above | `~/.codex/config.toml` or `.codex/config.toml` (trusted projects) |
| Codex Cloud | No. Cloud tasks have no documented way to use MCP servers | none |
| ChatGPT (web, custom MCP server / plugin) | Not directly. ChatGPT only does OAuth or no auth (an untested tunnel route exists, see below) | ChatGPT Plugins UI |
| Claude.ai and Claude Desktop custom connectors | Not without changes. They connect from Anthropic's cloud and default to OAuth | Claude settings, Connectors |

How L2 authenticates, from `apps/world-edge/src/auth.ts` and its README at 161c054: `/mcp` accepts `Authorization: Bearer <service token>`, where the Worker secret `MCP_SERVICE_TOKENS` holds a SHA-256 hash, a name and a `harness` per token, so every client gets its own token and the ops log records which harness wrote what. Browsers use a Cloudflare Access JWT instead. L2's README suggests an Access Bypass or Service Auth rule for `/mcp` so MCP clients reach the Worker. Use a Bypass rule. With a Service Auth rule, Access adds an Access JWT to service-token requests, and L2's `authenticate` (at 161c054) accepts any valid Access JWT as `harness: human` even without a bearer token, so anyone holding the Access service token could write as `human` and the per-client attribution is lost. We have asked L2 to reject Access service-token JWTs on `/mcp` (see the follow-up spec, R7). The Worker is not deployed yet; deploying it and the Access policy are Frank's decision. The short version: local agents work with a bearer token. ChatGPT needs a standard MCP OAuth surface on the Worker. The follow-up spec is in [chatgpt-oauth-followup.md](./chatgpt-oauth-followup.md).

## Values used on this page

| Name | Meaning |
| --- | --- |
| `https://world-edge.<account>.workers.dev/mcp` | The endpoint L2's README gives. Replace `<account>` once it is deployed. A custom domain needs L2 to pass `allowedHostnames` to `createMcpHandler` (L2 README). If L2 adopts option R7(b) of the OAuth follow-up, the bearer URL for local agents is a different hostname from the OAuth URL that ChatGPT uses. |
| `WORLD_CANVAS_URL` | Optional env var for the endpoint. |
| `WORLD_CANVAS_TOKEN` | Env var holding this client's service token (L2's README generates it with `openssl rand -hex 32` and stores only its hash). Use a different token per client and per person. Never commit its value. |
| `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET` | Env vars holding a Cloudflare Access service token, needed only if the Access policy on `/mcp` is Service Auth rather than Bypass (not recommended until L2 fixes the attribution gap above). |

Set the variables in the shell (or IDE process) that launches the agent, for example with `direnv` or your shell profile. Do not put the values in any file that is committed.

About the Cloudflare Access headers: Cloudflare Access accepts a service token sent as the `CF-Access-Client-Id` and `CF-Access-Client-Secret` request headers when the Access application has a Service Auth policy. Neither Anthropic nor OpenAI documents Cloudflare Access, so the header examples below are our design, not vendor guidance. With an Access Bypass rule on `/mcp` (L2's README option), leave those two headers out; the examples below show them as an optional variant.

## Claude Code

Source: https://code.claude.com/docs/en/mcp, fetched 2026-11-25.

### Project config (`.mcp.json`, committed)

```json
{
  "mcpServers": {
    "starlight-world": {
      "type": "http",
      "url": "${WORLD_CANVAS_URL:-https://world-edge.<account>.workers.dev/mcp}",
      "headers": {
        "Authorization": "Bearer ${WORLD_CANVAS_TOKEN}"
      }
    }
  }
}
```

Only if the Access policy on `/mcp` is Service Auth, add these two lines to `headers` (with Bypass, leave them out, because an unset variable would be sent as literal `${...}` text):

```json
        "CF-Access-Client-Id": "${CF_ACCESS_CLIENT_ID}",
        "CF-Access-Client-Secret": "${CF_ACCESS_CLIENT_SECRET}"
```

Facts from the Claude Code MCP docs:

- `type` is required for a remote server. `"http"` is Streamable HTTP; `"streamable-http"` is an accepted alias. A `url` with no `type` is a configuration error.
- `${VAR}` and `${VAR:-default}` expand in `command`, `args`, `env`, `url` and `headers`.
- If a variable is unset and has no default, the config still loads, the literal `${VAR}` text is sent, and `claude mcp list` shows a missing-variable warning. A 401 with that warning means the variable was not exported.
- In a remote server's `url` and `headers`, some credential variables always read as empty, for example `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `AWS_BEARER_TOKEN_BEDROCK`, `HTTPS_PROXY` and `NPM_TOKEN`. That is why this page uses a dedicated name, `WORLD_CANVAS_TOKEN`.
- When `headers.Authorization` is set, Claude Code uses it and does not fall back to OAuth. A rejected token shows as a failed connection.
- Interactive sessions ask for approval before using a server from `.mcp.json`. Until then `claude mcp list` shows it as pending. `claude mcp reset-project-choices` clears the choice. Non-interactive runs (`claude -p`, the Agent SDK, cloud sessions) load project servers without asking.

This repo's root `.mcp.json` currently holds the local `starlight-agent-canvas` stdio server. This lane does not change it. Add the `starlight-world` entry next to it when L2 publishes a real URL.

### CLI form

```bash
claude mcp add-json --scope project starlight-world \
  '{"type":"http","url":"https://world-edge.<account>.workers.dev/mcp","headers":{"Authorization":"Bearer ${WORLD_CANVAS_TOKEN}"}}'
```

Single quotes stop your shell from expanding the variable. Whether the Claude Code CLI then stores the `${WORLD_CANVAS_TOKEN}` text unexpanded is not stated in the docs and we could not test it (unverified), so the safest path is to edit `.mcp.json` by hand and then check the file. L2's README shows `claude mcp add --transport http starlight-world <url> --header "Authorization: Bearer <claude token>"`; that works but stores the token in plain text in `~/.claude.json`. Never run `claude mcp add --transport http ... --header "Authorization: Bearer $WORLD_CANVAS_TOKEN"` with double quotes in any scope: the shell expands the variable first and the token is written in plain text, into `.mcp.json` for `project` scope or `~/.claude.json` for `local` and `user` scope.

Scopes: `local` (default, this project, stored in `~/.claude.json`), `project` (shared, stored in `.mcp.json`), `user` (all your projects, stored in `~/.claude.json`).

Check it: `claude mcp get starlight-world`, `claude mcp list`, or `/mcp` inside a session.

### OAuth in Claude Code

Claude Code also supports OAuth for remote servers (dynamic client registration, client ID metadata documents, or a pre-registered client), started with `/mcp` or `claude mcp login starlight-world`. It discovers the authorization server from a 401 `WWW-Authenticate` header and RFC 9728 protected resource metadata. So once L2 ships the OAuth surface described in the follow-up spec, Claude Code users can drop the static header and sign in instead. Remove the `Authorization` header first, because a configured header disables the OAuth fallback.

### Claude.ai and Claude Desktop custom connectors

Sources: https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp and https://claude.com/docs/connectors/building/authentication, fetched 2026-11-25 by our research agent.

These connect from Anthropic's cloud, not from your machine, so the server must be reachable from the public internet and a Cloudflare Access login wall will block them. OAuth is the default. A static "Request headers" option exists but is described as beta and limited to some organizations. Treat Claude.ai connectors like ChatGPT: they need the OAuth follow-up. Claude Desktop does not read remote URLs from `claude_desktop_config.json`; add remote servers through its Connectors settings.

## Codex CLI, IDE extension and ChatGPT desktop app

Source: https://developers.openai.com/codex/mcp (canonical https://learn.chatgpt.com/docs/extend/mcp), fetched 2026-11-25.

The ChatGPT desktop app, Codex CLI and the IDE extension share one MCP configuration in `config.toml`. The default file is `~/.codex/config.toml`. A project can also have `.codex/config.toml`, which Codex loads only for trusted projects.

```toml
[mcp_servers.starlight-world]
url = "https://world-edge.<account>.workers.dev/mcp"
# Codex sends the value of this variable as "Authorization: Bearer <value>".
bearer_token_env_var = "WORLD_CANVAS_TOKEN"
# Only if the Access policy on /mcp is Service Auth (not Bypass). Header name -> env var name.
# env_http_headers = { "CF-Access-Client-Id" = "CF_ACCESS_CLIENT_ID", "CF-Access-Client-Secret" = "CF_ACCESS_CLIENT_SECRET" }
startup_timeout_sec = 20
tool_timeout_sec = 60
# Ask before any tool that is not marked read-only.
default_tools_approval_mode = "writes"
```

Facts from the Codex MCP docs:

- A server with a `url` is a Streamable HTTP server. There is no separate transport key.
- `bearer_token_env_var` names the variable; the token itself never goes in the file. `env_http_headers` maps header names to variable names. `http_headers` holds static values and must not be used for secrets.
- `startup_timeout_sec` defaults to 10 and `tool_timeout_sec` to 60.
- `enabled_tools` and `disabled_tools` filter tools. `default_tools_approval_mode` accepts `auto`, `prompt`, `writes` and `approve`; `writes` prompts for tools not marked read-only.
- If no credential resolves, Codex connects without authentication, so an unset `WORLD_CANVAS_TOKEN` shows up as a 401 from the server, not a config error.
- `codex mcp login <name>` starts MCP OAuth (CIMD or DCR). It is not needed for a static bearer token.
- Older third-party guides tell you to set `experimental_use_rmcp_client`. Current OpenAI docs do not mention it, and a third-party report says recent CLI versions ignore it as an unknown key. Do not add it.

CLI form (writes to the user-level `~/.codex/config.toml`; edit `.codex/config.toml` by hand for a project entry):

```bash
codex mcp add starlight-world --url https://world-edge.<account>.workers.dev/mcp --bearer-token-env-var WORLD_CANVAS_TOKEN
codex mcp list
```

The `--url` and `--bearer-token-env-var` flags are defined in the Codex source (`codex-rs/cli/src/mcp_cmd.rs`) and listed in https://developers.openai.com/codex/cli/reference (checked 2026-11-25). Run `codex mcp add --help` on your build if it is older. The `env_http_headers` line still has to be added by hand.

In the desktop app: Settings, MCP servers, Add server, choose Streamable HTTP, enter the URL, save, then Restart (same OpenAI page). Type `/mcp` in the composer to see connected servers.

## Codex Cloud

Sources: https://learn.chatgpt.com/codex/environments/cloud-environments and https://developers.openai.com/codex/cloud/environments/, fetched 2026-11-25; open issues https://github.com/openai/codex/issues/57061 and https://github.com/openai/codex/issues/45264.

There is no documented way for Codex Cloud tasks to use this MCP server today. OpenAI's cloud environment docs cover setup scripts, environment variables, network secrets, internet allowlists, Tailscale and OIDC, and say nothing about MCP servers. The Codex MCP page lists the desktop app, CLI and IDE extension as the clients that share MCP configuration, and does not list cloud tasks. Open issue #57061 on `openai/codex` reports that cloud tasks cannot see remote MCP servers installed in ChatGPT; #45264 mentions in passing that there is no way to attach MCP servers in Cloud. OpenAI does not state the absence in one sentence, so this is a strong inference from the docs plus the open issues, as of 2026-11-25.

What to do instead: run world edits from Codex CLI, the IDE extension or the desktop app. If a cloud task must reach the world, the only route is plain HTTPS from the task's shell (for example a script using `@starlight-agent-canvas/world-agents`), which needs the Worker hostname on the environment's internet allowlist and the token as a network secret. That is not MCP and we have not tested it.

## ChatGPT (web)

Sources, all fetched 2026-11-25: https://developers.openai.com/plugins/build/auth.md (read in full by the lane lead), https://developers.openai.com/api/docs/guides/developer-mode (custom MCP server guide, read by our research agent), https://developers.openai.com/codex/mcp.

### Plain answer: ChatGPT cannot connect directly to L2's server as built

ChatGPT's custom MCP servers support OAuth, no authentication, or a mix of the two per tool. OpenAI's auth guide says ChatGPT does not support machine-to-machine OAuth grants such as client credentials, and cannot present custom API keys. So ChatGPT cannot send our static bearer token, and it cannot send Cloudflare Access service-token headers. Behind an Access login wall its requests are stopped before they reach the Worker (our inference: Access answers non-browser clients without a valid token with a login redirect). Even past Access, the only bearer ChatGPT ever sends is an OAuth access token it obtained itself.

"No authentication" is not an option for this server: anyone who knows the URL could write to the world.

One untested route exists: the custom MCP server form also offers a Tunnel connection (OpenAI's Secure MCP Tunnel, https://developers.openai.com/api/docs/guides/secure-mcp-tunnels), and OpenAI's tunnel-client onboarding notes say configured request headers are forwarded to the private server. It needs a host running the tunnel client and we have not verified it with a static bearer, so do not plan on it.

To support ChatGPT properly, L2 must add a standard MCP OAuth 2.1 surface. The precise follow-up is [chatgpt-oauth-followup.md](./chatgpt-oauth-followup.md).

### Setup once L2 ships OAuth

The current OpenAI guide describes this path: ChatGPT on the web, Plugins (chatgpt.com/plugins), the plus button, Add custom MCP server, then name and Server URL, choose OAuth as the authentication, accept the risk warning, and create it as a plugin. Install it and mention it with `@` in a chat.

- Transports: SSE and streaming HTTP. Our Streamable HTTP `/mcp` endpoint is fine.
- Write tools work. ChatGPT asks the user to confirm write actions by default. It treats any tool without the MCP `readOnlyHint` annotation as a write. The user can choose to remember approve or deny for the rest of that conversation.
- Redirect URI: copy the exact value shown on the server's management page into L2's allowlist. It is `https://chatgpt.com/connector_platform_oauth_redirect` when the authorization server meets RFC 9207 issuer identification, otherwise `https://chatgpt.com/connector/oauth/{callback_id}`.
- Plans and the "Developer mode" toggle: unconfirmed. The help center page on developer mode could not be fetched, and secondary sources disagree on which plans have it and where the toggle lives. Check your plan and ask your workspace admin; Business and Enterprise admins control MCP permissions.

### OpenAI API (Responses API `mcp` tool)

Sources: https://developers.openai.com/api/docs/guides/tools-connectors-mcp and the OpenAI cookbook MCP tool guide, fetched 2026-11-25 by our research agent.

Code that calls the OpenAI API directly (not the ChatGPT app) can pass an `authorization` value to the `mcp` tool on each request, and OpenAI does not store it. So an API-based agent can use the static bearer token today. A `headers` map for other headers (such as the Access service token) is shown in the cookbook and SDK types but not in a dedicated paragraph of the current guide, so treat it as unconfirmed.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| 401 on every call | Token variable not exported in the process that launched the agent, or a Claude Code credential name that reads as empty. |
| Login page HTML or a 302 instead of JSON | Cloudflare Access is in front of `/mcp` and the service-token headers are missing or the Access app has no Service Auth policy. |
| Claude Code shows the server as pending | Project server not approved yet. Start `claude` interactively and approve it. |
| `STALE_VERSION` from a write tool | Someone changed the node first. Re-read it and retry with the new `baseVersion` (spec 4.1). |
| `CANON_FORBIDDEN` | An op tried to set canon status `canon`. Use `propose_canon` instead (spec 3). |
| `CANON_LOCKED` | The target is already canon. It cannot be changed or proposed again through ops; changing canon needs a change to the canon files in git, approved by the Creator. |

## Sources

| Source | Used for | Read on |
| --- | --- | --- |
| https://code.claude.com/docs/en/mcp | Claude Code config, env expansion, scopes, approval, OAuth | 2026-11-25 |
| https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp | Claude.ai connectors run from Anthropic's cloud | 2026-11-25 |
| https://claude.com/docs/connectors/building/authentication | Claude.ai connector auth options | 2026-11-25 |
| https://developers.openai.com/codex/mcp | Codex config.toml keys, shared config, OAuth login | 2026-11-25 |
| https://developers.openai.com/codex/config-reference | Project config only in trusted projects | 2026-11-25 |
| https://learn.chatgpt.com/codex/environments/cloud-environments | Codex Cloud environment features (no MCP) | 2026-11-25 |
| https://github.com/openai/codex/issues/57061, https://github.com/openai/codex/issues/45264 | Open issues on MCP in cloud tasks | 2026-11-25 |
| https://developers.openai.com/codex/cli/reference | `codex mcp add` flags | 2026-11-25 |
| https://developers.openai.com/api/docs/guides/secure-mcp-tunnels | ChatGPT tunnel connection option | 2026-11-25 |
| https://developers.openai.com/plugins/build/auth.md | ChatGPT OAuth requirements, no API keys, redirect URIs | 2026-11-25 |
| https://developers.openai.com/api/docs/guides/developer-mode | ChatGPT custom MCP server setup, transports, write confirmations | 2026-11-25 |
| https://developers.openai.com/api/docs/guides/tools-connectors-mcp | Responses API `mcp` tool `authorization` | 2026-11-25 |

Research notes with every claim and its source are kept with the L5 session outputs (`research/claude-code-mcp.md`, `research/codex-mcp.md`, `research/chatgpt-mcp-oauth.md`).
