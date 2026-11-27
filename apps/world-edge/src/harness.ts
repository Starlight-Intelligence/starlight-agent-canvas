/**
 * Harness label for an OAuth grant: which client identity the provider
 * validated. That is the client_id when it is a Client ID Metadata Document
 * URL (the provider fetched and validated the document at that URL), else the
 * non-loopback redirect URI (which passed the redirect allowlist). It is never
 * taken from self-asserted fields: client_name, tool arguments or headers.
 *
 * The label is attribution for normal use, not a security boundary. ChatGPT
 * and claude.ai are public clients, so a user who may sign in through Access
 * can register a client with their redirect URI (or present their CIMD
 * client_id), finish the flow in their own browser, read the code and redeem
 * it with their own PKCE verifier, and get a token labelled chatgpt or
 * claude-ai. The authenticated identity is the actor (the Access email), not
 * the harness.
 *
 * Every pattern is anchored on the full URL: scheme, exact host, path, and no
 * port, userinfo, query or fragment, so lookalike hosts and URLs that merely
 * contain a trusted URL never map.
 *
 * Order matters: the Codex CIMD URL (https://chatgpt.com/oauth/codex/client.json)
 * would also match the generic ChatGPT {callback_id} pattern, so Codex is
 * checked first.
 */

export type GrantHarness = 'codex' | 'chatgpt' | 'claude-ai' | 'claude' | 'mcp-client';

const ID = '[A-Za-z0-9_-]+';

const CLIENT_ID_RULES: [RegExp, GrantHarness][] = [
  [new RegExp(`^https://chatgpt\\.com/oauth/codex/(?:${ID}/)?client\\.json$`), 'codex'],
  [new RegExp(`^https://chatgpt\\.com/oauth/(?:${ID}/)?client\\.json$`), 'chatgpt'],
  [/^https:\/\/claude\.ai\/oauth\/mcp-oauth-client-metadata$/, 'claude-ai'],
  [/^https:\/\/claude\.ai\/oauth\/claude-code-client-metadata$/, 'claude'],
];

const REDIRECT_RULES: [RegExp, GrantHarness][] = [
  [/^https:\/\/chatgpt\.com\/connector_platform_oauth_redirect$/, 'chatgpt'],
  [/^https:\/\/chatgpt\.com\/connector\/oauth(?:\/[A-Za-z0-9._~-]+)+$/, 'chatgpt'],
  [/^https:\/\/claude\.ai\/api\/mcp\/auth_callback$/, 'claude-ai'],
];

export function harnessForClient(input: { clientId: string; redirectUri: string }): GrantHarness {
  for (const [pattern, harness] of CLIENT_ID_RULES) if (pattern.test(input.clientId)) return harness;
  for (const [pattern, harness] of REDIRECT_RULES) if (pattern.test(input.redirectUri)) return harness;
  return 'mcp-client';
}
