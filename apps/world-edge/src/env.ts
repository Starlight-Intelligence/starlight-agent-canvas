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
}

declare global {
  // Lets Agents SDK helpers (getAgentByName, routeAgentRequest) infer this Env.
  namespace Cloudflare {
    interface Env extends WorkerEnv {}
  }
}

type WorkerEnv = Env;
