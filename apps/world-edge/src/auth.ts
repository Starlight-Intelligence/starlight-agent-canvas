import { harnessSchema, worldIdSchema } from '@starlight-agent-canvas/world';
import { z } from 'zod';
import type { Env } from './env.js';

/** OAuth scopes this Worker grants. Order is the display order on the consent page. */
export const WORLD_SCOPES = ['world:read', 'world:write', 'world:propose'] as const;
export type WorldScope = (typeof WORLD_SCOPES)[number];

export function isWorldScope(value: unknown): value is WorldScope {
  return typeof value === 'string' && (WORLD_SCOPES as readonly string[]).includes(value);
}

/**
 * Authenticated caller. Every write records `harness` and `actor` in the
 * ops_log. Built only by `authenticate`, `authenticateMcp` or the OAuth
 * provider's verified token context (src/oauth.ts); never parsed from client
 * JSON.
 */
export type Principal = {
  /** human for browsers behind Access; claude, codex, chatgpt ... for service tokens and OAuth clients. */
  harness: string;
  /** Stable id: Access identity email (browser or OAuth sign-in), or the service token name. */
  actor: string;
  /**
   * Epoch ms after which this credential is no longer valid (Access `exp`).
   * Long-lived connections (WebSockets) must stop serving the principal then.
   */
  expiresAt?: number;
  /**
   * SHA-256 of the presented service token. Lets a long-lived connection
   * re-check that the token is still listed in MCP_SERVICE_TOKENS (revocation).
   * The hash never leaves the Worker and its Durable Objects.
   */
  tokenSha256?: string;
  /**
   * World ids this principal may read and write. Absent means every world
   * (Access users, OAuth clients and unscoped service tokens). Set from the
   * `worlds` field of the matching MCP_SERVICE_TOKENS entry.
   */
  worlds?: readonly string[];
} & (
  | { via: 'access' | 'service-token' }
  /** An OAuth access token this Worker issued. `scopes` are the granted scopes the provider verified. */
  | { via: 'oauth'; scopes: WorldScope[] }
);

/**
 * Scopes a principal holds on /mcp. Service tokens hold all of them (they
 * predate OAuth and are per-client secrets). OAuth principals hold exactly
 * what was granted. Browser Access identities never reach /mcp and hold none.
 */
export function principalScopes(principal: Principal): readonly WorldScope[] {
  switch (principal.via) {
    case 'service-token':
      return WORLD_SCOPES;
    case 'oauth':
      return principal.scopes;
    case 'access':
      return [];
  }
}

/** Internal header the Worker sets after auth, before forwarding to the Durable Object. */
export const PRINCIPAL_HEADER = 'x-world-principal';

export class AuthError extends Error {
  constructor(message: string, readonly status = 401) {
    super(message);
    this.name = 'AuthError';
  }
}

const serviceTokenEntrySchema = z.object({
  name: z.string().min(1).max(200),
  harness: harnessSchema,
  sha256: z.string().regex(/^[0-9a-f]{64}$/, 'sha256 must be 64 lowercase hex chars.'),
  /** Optional allowlist of world ids. Omit for a token that may use every world. */
  worlds: z.array(worldIdSchema).min(1).max(256).optional(),
});
const serviceTokensSchema = z.array(serviceTokenEntrySchema).max(256);

const encoder = new TextEncoder();

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time compare of two equal-length hex strings. */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function parseServiceTokens(env: Pick<Env, 'MCP_SERVICE_TOKENS'>): z.infer<typeof serviceTokensSchema> | null {
  if (!env.MCP_SERVICE_TOKENS) return null;
  try {
    return serviceTokensSchema.parse(JSON.parse(env.MCP_SERVICE_TOKENS));
  } catch {
    // Misconfigured secret: fail closed. Do not echo the secret.
    return null;
  }
}

function matchTokenHash(presented: string, entries: z.infer<typeof serviceTokensSchema>) {
  let match: (typeof entries)[number] | null = null;
  for (const entry of entries) {
    if (timingSafeEqualHex(presented, entry.sha256)) match = entry;
  }
  return match;
}

export async function verifyServiceToken(token: string, env: Pick<Env, 'MCP_SERVICE_TOKENS'>): Promise<Principal | null> {
  if (token.length < 16 || token.length > 512) return null;
  const entries = parseServiceTokens(env);
  if (!entries) return null;
  const presented = await sha256Hex(token);
  const match = matchTokenHash(presented, entries);
  if (!match) return null;
  return { harness: match.harness, actor: match.name, via: 'service-token', tokenSha256: presented, ...(match.worlds ? { worlds: [...match.worlds] } : {}) };
}

/**
 * Is `principal` still authorized right now? Every principal expires at its
 * expiresAt; service-token principals must also still be listed, under the
 * same name and harness, in the current MCP_SERVICE_TOKENS. Used by
 * long-lived WebSocket connections, which only carry access and
 * service-token principals (OAuth principals stay on per-request /mcp).
 */
export function principalStillValid(principal: Principal, env: Pick<Env, 'MCP_SERVICE_TOKENS'>, now = Date.now()): boolean {
  if (principal.expiresAt !== undefined && now >= principal.expiresAt) return false;
  if (principal.via === 'service-token') {
    if (!principal.tokenSha256) return false;
    const entries = parseServiceTokens(env);
    const match = entries ? matchTokenHash(principal.tokenSha256, entries) : null;
    return Boolean(match && match.name === principal.actor && match.harness === principal.harness && sameWorlds(match.worlds, principal.worlds));
  }
  return true;
}

function sameWorlds(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  if (!a || !b) return a === b;
  return a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n');
}

/** May `principal` read or write `worldId`? Unscoped principals may use every world. */
export function canAccessWorld(principal: Principal, worldId: string): boolean {
  return principal.worlds === undefined || principal.worlds.includes(worldId);
}

export function worldForbidden(worldId: string): Response {
  return Response.json(
    { error: { code: 'WORLD_FORBIDDEN', message: `This credential is not authorized for world "${worldId}".` } },
    { status: 403 },
  );
}

// ---------------------------------------------------------------------------
// RS256 JWT verification against a JWKS URL. Used for the browser Access JWT
// (Cf-Access-Jwt-Assertion, keys from <team domain>/cdn-cgi/access/certs) and
// for the id_token of the Access for SaaS OIDC sign-in (src/access-oidc.ts).
// ---------------------------------------------------------------------------

interface Jwk extends JsonWebKey {
  kid?: string;
}

/** One cache entry per JWKS URL, so the two Access key sets never evict each other. */
const jwksCache = new Map<string, { keys: Jwk[]; fetchedAt: number }>();
/** When an unknown kid last started a forced refetch of a JWKS URL, successful or not. */
const jwksForcedAt = new Map<string, number>();
const JWKS_TTL_MS = 10 * 60 * 1000;
/** At most one forced refetch per JWKS URL in this window because of an unknown kid. */
const JWKS_FORCED_REFRESH_MS = 30 * 1000;

export type JwksFetcher = (url: string) => Promise<{ keys: Jwk[] }>;

const defaultFetcher: JwksFetcher = async (url) => {
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new AuthError(`Could not load Access signing keys (${response.status}).`, 503);
  return (await response.json()) as { keys: Jwk[] };
};

function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((value.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function decodeJson(segment: string): Record<string, unknown> {
  const value: unknown = JSON.parse(new TextDecoder().decode(base64UrlDecode(segment)));
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new SyntaxError('JWT segment is not a JSON object.');
  return value as Record<string, unknown>;
}

export function normalizeTeamDomain(domain: string): string {
  const withScheme = /^https?:\/\//.test(domain) ? domain : `https://${domain}`;
  const url = new URL(withScheme);
  if (url.protocol !== 'https:') throw new AuthError('ACCESS_TEAM_DOMAIN must be https.', 500);
  return url.origin;
}

async function fetchKeys(url: string, fetcher: JwksFetcher): Promise<Jwk[]> {
  let result: { keys: Jwk[] };
  try {
    result = await fetcher(url);
  } catch (error) {
    if (error instanceof AuthError) throw error;
    // Network failure or a body that is not JSON: the keys are unavailable, not the token bad.
    throw new AuthError('Could not load Access signing keys.', 503);
  }
  return Array.isArray(result?.keys) ? result.keys : [];
}

/** Fetch the keys for `url` in this request and cache them. */
async function fetchAndCacheKeys(url: string, fetcher: JwksFetcher, now: number): Promise<Jwk[]> {
  const keys = await fetchKeys(url, fetcher);
  jwksCache.set(url, { keys, fetchedAt: now });
  return keys;
}

/** Cached keys for `url`, fetched when missing or older than the TTL. */
async function loadKeys(url: string, fetcher: JwksFetcher, now: number): Promise<Jwk[]> {
  const cached = jwksCache.get(url);
  if (cached && now - cached.fetchedAt < JWKS_TTL_MS) return cached.keys;
  return fetchAndCacheKeys(url, fetcher, now);
}

/**
 * Refetch because a token named a kid the cache does not have (key rotation).
 * Rate limited per URL, so tokens with made-up kids cannot make every request
 * refetch: the 30 s window starts when a forced fetch begins, so concurrent
 * unknown-kid requests and a failed forced fetch cause at most one forced
 * fetch per URL per window. Returns null (the caller answers 401) when a
 * forced refetch started too recently.
 *
 * Every fetch runs in the request that needs it; no promise is shared across
 * requests, because workerd may cancel I/O that belongs to another request.
 * Trade-off: after a key rotation, a legitimate token with the new kid that
 * arrives inside the window, while the first refetch is still running or
 * after one that failed, gets 401, and the client retries.
 */
async function refreshKeysForUnknownKid(url: string, fetcher: JwksFetcher, now: number): Promise<Jwk[] | null> {
  if (now - (jwksForcedAt.get(url) ?? -Infinity) < JWKS_FORCED_REFRESH_MS) return null;
  jwksForcedAt.set(url, now);
  return fetchAndCacheKeys(url, fetcher, now);
}

/** Test hook. */
export function resetJwksCache(): void {
  jwksCache.clear();
  jwksForcedAt.clear();
}

export interface Rs256JwtOptions {
  /** JWKS endpoint holding the signing keys. */
  jwksUrl: string;
  /** Used in error messages, e.g. "Access token". */
  label: string;
  /** Refuse a token whose header has no string kid. */
  requireKid?: boolean;
  fetcher?: JwksFetcher;
  now?: number;
}

/**
 * Verify an RS256 JWT: header alg, key by kid from the JWKS (cached, refetched
 * on an unknown kid at most once per 30 s per URL), signature, exp (required)
 * and nbf with 60 s skew. Returns the payload. Issuer, audience and every other
 * claim are the caller's to check. Every failure is an AuthError: 503 when the
 * keys cannot be loaded, 401 for anything about the token or the key (bad
 * base64, a key WebCrypto refuses for RS256 verification, a bad signature).
 */
export async function verifyRs256Jwt(token: string, options: Rs256JwtOptions): Promise<Record<string, unknown>> {
  const { label } = options;
  const parts = token.split('.');
  if (parts.length !== 3) throw new AuthError(`Malformed ${label}.`);
  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    header = decodeJson(parts[0]!);
    payload = decodeJson(parts[1]!);
  } catch {
    throw new AuthError(`Malformed ${label}.`);
  }
  if (header.alg !== 'RS256') throw new AuthError(`Unsupported ${label} algorithm.`);
  if (options.requireKid && typeof header.kid !== 'string') throw new AuthError(`${label} has no key id.`);

  const fetcher = options.fetcher ?? defaultFetcher;
  const nowMs = options.now ?? Date.now();
  const keys = await loadKeys(options.jwksUrl, fetcher, nowMs);
  let jwk = keys.find((key) => key.kid === header.kid);
  if (!jwk) {
    // Key rotation: refetch, rate limited.
    const refreshed = await refreshKeysForUnknownKid(options.jwksUrl, fetcher, nowMs);
    jwk = refreshed?.find((key) => key.kid === header.kid);
  }
  if (!jwk) throw new AuthError(`${label} signed by an unknown key.`);

  let valid: boolean;
  try {
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    valid = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      key,
      base64UrlDecode(parts[2]!),
      encoder.encode(`${parts[0]}.${parts[1]}`),
    );
  } catch {
    // Signature segment is not base64url, or the key is not an RS256 verification key.
    throw new AuthError(`${label} could not be verified.`);
  }
  if (!valid) throw new AuthError(`${label} signature is invalid.`);

  const nowSec = Math.floor(nowMs / 1000);
  const skew = 60;
  if (typeof payload.exp !== 'number' || payload.exp + skew < nowSec) throw new AuthError(`${label} expired.`);
  if (typeof payload.nbf === 'number' && payload.nbf - skew > nowSec) throw new AuthError(`${label} not yet valid.`);
  return payload;
}

export async function verifyAccessJwt(
  token: string,
  env: Pick<Env, 'ACCESS_TEAM_DOMAIN' | 'ACCESS_AUD'>,
  options: { fetcher?: JwksFetcher; now?: number } = {},
): Promise<Principal> {
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) {
    throw new AuthError('Access is not configured on this Worker (ACCESS_TEAM_DOMAIN, ACCESS_AUD).', 401);
  }
  const teamDomain = normalizeTeamDomain(env.ACCESS_TEAM_DOMAIN);
  const payload = await verifyRs256Jwt(token, {
    jwksUrl: `${teamDomain}/cdn-cgi/access/certs`,
    label: 'Access token',
    fetcher: options.fetcher,
    now: options.now,
  });
  if (payload.iss !== teamDomain) throw new AuthError('Access token issuer mismatch.');
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(env.ACCESS_AUD)) throw new AuthError('Access token audience mismatch.');

  // Only a browser identity (email) is a human. Access also signs a JWT for
  // requests that carry an Access service token (CF-Access-Client-Id/Secret);
  // that JWT has common_name and no email. It names no person and no harness,
  // so it never becomes a principal. Any common_name claim at all (even null or
  // a number) disqualifies the token, and email must have visible content.
  if (payload.common_name !== undefined || typeof payload.email !== 'string' || payload.email.trim().length === 0) {
    throw new AuthError('Access service-token assertions are not accepted; use a bearer token.');
  }
  return { harness: 'human', actor: payload.email, via: 'access', expiresAt: (payload.exp as number) * 1000 };
}

async function bearerPrincipal(request: Request, env: Env): Promise<Principal | null> {
  const authorization = request.headers.get('authorization');
  if (!authorization?.toLowerCase().startsWith('bearer ')) return null;
  return verifyServiceToken(authorization.slice(7).trim(), env);
}

/**
 * Resolve the caller on /mcp. Only a per-client bearer service token is
 * accepted. Access JWTs are ignored here, whatever Access policy sits in
 * front of /mcp. Returns null when the bearer is missing or invalid.
 */
export async function authenticateMcp(request: Request, env: Env): Promise<Principal | null> {
  return bearerPrincipal(request, env);
}

/**
 * Resolve the caller on every other authenticated route. Order: bearer
 * service token, then the Access assertion header of a browser identity.
 * Returns null when neither is present or valid; callers turn that into 401.
 */
export async function authenticate(
  request: Request,
  env: Env,
  options: { fetcher?: JwksFetcher; now?: number } = {},
): Promise<Principal | null> {
  const principal = await bearerPrincipal(request, env);
  if (principal) return principal;
  const assertion = request.headers.get('cf-access-jwt-assertion');
  if (assertion) {
    try {
      return await verifyAccessJwt(assertion, env, options);
    } catch (error) {
      if (error instanceof AuthError && error.status >= 500) throw error;
      return null;
    }
  }
  return null;
}

export function unauthorized(message = 'Authentication required.'): Response {
  return Response.json(
    { error: { code: 'UNAUTHENTICATED', message } },
    { status: 401, headers: { 'www-authenticate': 'Bearer realm="world-edge"' } },
  );
}

/** Serialize for the internal header. Only the Worker sets it, after stripping any client copy. */
export function encodePrincipal(principal: Principal): string {
  return JSON.stringify(principal);
}

const principalBase = {
  harness: harnessSchema,
  actor: z.string().min(1).max(200),
  expiresAt: z.number().int().positive().optional(),
  tokenSha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  worlds: z.array(worldIdSchema).min(1).max(256).optional(),
};
const principalSchema = z.discriminatedUnion('via', [
  z.object({ ...principalBase, via: z.enum(['access', 'service-token']) }),
  z.object({ ...principalBase, via: z.literal('oauth'), scopes: z.array(z.enum(WORLD_SCOPES)).max(WORLD_SCOPES.length) }),
]);

export function decodePrincipal(value: string | null): Principal | null {
  if (!value) return null;
  try {
    return principalSchema.parse(JSON.parse(value));
  } catch {
    return null;
  }
}
