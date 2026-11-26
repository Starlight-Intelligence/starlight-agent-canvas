import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';
import type { WorldAgent } from './world-agent.js';

/**
 * Worker bindings. Names match wrangler.jsonc. AI, WORLD_VECTORS, WORLD_INDEX
 * and WORLD_MEDIA are optional at runtime so local dev and tests run without
 * them; code paths check for presence and degrade.
 */
export interface Env {
  WorldAgent: DurableObjectNamespace<WorldAgent>;
  WORLD_INDEX?: D1Database;
  WORLD_MEDIA?: R2Bucket;
  WORLD_VECTORS?: VectorizeIndex;
  AI?: Ai;

  /** Cloudflare Access team domain, e.g. "https://<team>.cloudflareaccess.com". Plain var. */
  ACCESS_TEAM_DOMAIN?: string;
  /** Application audience (AUD) tag of the Access application. Plain var. */
  ACCESS_AUD?: string;

  /**
   * Secret. JSON array of service tokens for MCP clients:
   * [{"name":"claude-code-frank","harness":"claude","sha256":"<hex of token>"}].
   * Only hashes are stored; the raw token lives in the MCP client config.
   */
  MCP_SERVICE_TOKENS?: string;
  /** Secret. HMAC key for signed R2 upload URLs. */
  MEDIA_SIGNING_KEY?: string;

  // --- OAuth for MCP clients (src/oauth.ts). OAuth is on only when both
  // PUBLIC_ORIGIN and OAUTH_KV are present.

  /**
   * Plain var. The one public origin of this Worker, e.g. "https://world.example.com":
   * https, no path, no trailing slash (http only on a loopback host for local dev).
   * The OAuth issuer is this value and the protected resource is `${PUBLIC_ORIGIN}/mcp`.
   */
  PUBLIC_ORIGIN?: string;
  /** KV namespace for the OAuth provider: clients, grants, tokens (hashed), consent and upstream transactions. */
  OAUTH_KV?: KVNamespace;
  /**
   * Plain var. Whitespace or comma separated OAuth redirect URI allowlist (src/redirect-allowlist.ts).
   * Unset or empty: no OAuth redirect is allowed.
   */
  OAUTH_REDIRECT_ALLOWLIST?: string;

  /** Secret. Client ID of the Access for SaaS (OIDC) application. */
  ACCESS_CLIENT_ID?: string;
  /** Secret. Client secret of the Access for SaaS (OIDC) application. */
  ACCESS_CLIENT_SECRET?: string;
  /** Secret. Token endpoint, https://<team>.cloudflareaccess.com/cdn-cgi/access/sso/oidc/<client_id>/token. */
  ACCESS_TOKEN_URL?: string;
  /** Secret. Authorization endpoint, .../sso/oidc/<client_id>/authorization. */
  ACCESS_AUTHORIZATION_URL?: string;
  /** Secret. Key endpoint, .../sso/oidc/<client_id>/jwks. */
  ACCESS_JWKS_URL?: string;

  /** Set by @cloudflare/workers-oauth-provider before it calls a handler. Never configured. */
  OAUTH_PROVIDER?: OAuthHelpers;
}

declare global {
  // Lets Agents SDK helpers (getAgentByName, routeAgentRequest) infer this Env.
  namespace Cloudflare {
    interface Env extends WorkerEnv {}
  }
}

type WorkerEnv = Env;
