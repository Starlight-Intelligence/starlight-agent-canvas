/**
 * Harness label for an OAuth grant, from identities the client cannot fake:
 * its client_id when that is a Client ID Metadata Document URL (the provider
 * fetched and validated the document at that URL), else its non-loopback
 * redirect URI (which passed the redirect allowlist). Never from client_name,
 * tool arguments or anything else the client asserts.
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
