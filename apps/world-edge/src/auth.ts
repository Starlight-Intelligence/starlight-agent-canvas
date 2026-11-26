import { harnessSchema } from '@starlight-agent-canvas/world';
import { z } from 'zod';
import type { Env } from './env.js';

/**
 * Authenticated caller. Every write records `harness` and `actor` in the
 * ops_log. Built only by `authenticate`; never parsed from client JSON.
 */
export interface Principal {
  /** human for browsers behind Access; claude, codex, chatgpt ... for service tokens. */
  harness: string;
  /** Stable id: Access email/sub, or the service token name. */
  actor: string;
  via: 'access' | 'service-token';
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
  return match ? { harness: match.harness, actor: match.name, via: 'service-token', tokenSha256: presented } : null;
}

/**
 * Is `principal` still authorized right now? Access principals expire with
 * their assertion; service-token principals must still be listed, under the
 * same name and harness, in the current MCP_SERVICE_TOKENS.
 */
export function principalStillValid(principal: Principal, env: Pick<Env, 'MCP_SERVICE_TOKENS'>, now = Date.now()): boolean {
  if (principal.expiresAt !== undefined && now >= principal.expiresAt) return false;
  if (principal.via === 'service-token') {
    if (!principal.tokenSha256) return false;
    const entries = parseServiceTokens(env);
    const match = entries ? matchTokenHash(principal.tokenSha256, entries) : null;
    return Boolean(match && match.name === principal.actor && match.harness === principal.harness);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Cloudflare Access JWT (Cf-Access-Jwt-Assertion), RS256, keys from
// <team domain>/cdn-cgi/access/certs.
// ---------------------------------------------------------------------------

interface Jwk extends JsonWebKey {
  kid?: string;
}

interface JwksCache {
  url: string;
  keys: Jwk[];
  /** When the current keys were fetched (TTL base). */
  fetchedAt: number;
  /** Last fetch of any kind; an unknown kid cannot force another one within the interval. */
  lastFetchAt: number;
  /** kid -> epoch ms until which it is known not to exist. */
  unknownKids: Map<string, number>;
}

let jwksCache: JwksCache | null = null;
let jwksInFlight: Promise<Jwk[]> | null = null;
export const JWKS_TTL_MS = 10 * 60 * 1000;
/** An unknown kid can trigger a refetch at most once per this interval, Worker-isolate wide. */
export const JWKS_UNKNOWN_KID_REFETCH_MS = 60 * 1000;
const MAX_NEGATIVE_KIDS = 1024;

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
  return JSON.parse(new TextDecoder().decode(base64UrlDecode(segment))) as Record<string, unknown>;
}

export function normalizeTeamDomain(domain: string): string {
  const withScheme = /^https?:\/\//.test(domain) ? domain : `https://${domain}`;
  const url = new URL(withScheme);
  if (url.protocol !== 'https:') throw new AuthError('ACCESS_TEAM_DOMAIN must be https.', 500);
  return url.origin;
}

async function fetchKeys(url: string, fetcher: JwksFetcher, now: number): Promise<Jwk[]> {
  // Concurrent misses share one fetch.
  if (!jwksInFlight) {
    jwksInFlight = (async () => {
      try {
        const { keys } = await fetcher(url);
        jwksCache = {
          url,
          keys: Array.isArray(keys) ? keys : [],
          fetchedAt: now,
          // Any fetch is as fresh as a forced one.
          lastFetchAt: now,
          unknownKids: new Map(),
        };
        return jwksCache.keys;
      } finally {
        jwksInFlight = null;
      }
    })();
  }
  return jwksInFlight;
}

/**
 * Resolve the signing key for `kid`. Keys are cached for JWKS_TTL_MS. An
 * unknown kid forces a refetch at most once per JWKS_UNKNOWN_KID_REFETCH_MS,
 * and a kid still unknown after a refetch is negative-cached for that
 * interval, so unverified tokens with random kids cannot drive a fetch per
 * request.
 */
async function keyFor(teamDomain: string, kid: unknown, fetcher: JwksFetcher, now: number): Promise<Jwk | null> {
  const url = `${teamDomain}/cdn-cgi/access/certs`;
  const kidKey = typeof kid === 'string' ? kid : '';
  let cache = jwksCache?.url === url ? jwksCache : null;
  if (!cache || now - cache.fetchedAt >= JWKS_TTL_MS) {
    await fetchKeys(url, fetcher, now);
    cache = jwksCache!;
  }
  const found = cache.keys.find((key) => key.kid === kid);
  if (found) return found;

  const negativeUntil = cache.unknownKids.get(kidKey);
  if (negativeUntil !== undefined && now < negativeUntil) return null;
  if (now - cache.lastFetchAt < JWKS_UNKNOWN_KID_REFETCH_MS) {
    rememberUnknown(cache, kidKey, cache.lastFetchAt + JWKS_UNKNOWN_KID_REFETCH_MS);
    return null;
  }
  // Key rotation: refetch once for this interval.
  await fetchKeys(url, fetcher, now);
  cache = jwksCache!;
  const rotated = cache.keys.find((key) => key.kid === kid);
  if (rotated) return rotated;
  rememberUnknown(cache, kidKey, now + JWKS_UNKNOWN_KID_REFETCH_MS);
  return null;
}

function rememberUnknown(cache: JwksCache, kid: string, until: number): void {
  if (cache.unknownKids.size >= MAX_NEGATIVE_KIDS) cache.unknownKids.clear();
  cache.unknownKids.set(kid, until);
}

/** Test hook. */
export function resetJwksCache(): void {
  jwksCache = null;
  jwksInFlight = null;
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
  const parts = token.split('.');
  if (parts.length !== 3) throw new AuthError('Malformed Access token.');
  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    header = decodeJson(parts[0]!);
    payload = decodeJson(parts[1]!);
  } catch {
    throw new AuthError('Malformed Access token.');
  }
  if (header.alg !== 'RS256') throw new AuthError('Unsupported Access token algorithm.');

  const fetcher = options.fetcher ?? defaultFetcher;
  const jwk = await keyFor(teamDomain, header.kid, fetcher, options.now ?? Date.now());
  if (!jwk) throw new AuthError('Access token signed by an unknown key.');

  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    base64UrlDecode(parts[2]!),
    encoder.encode(`${parts[0]}.${parts[1]}`),
  );
  if (!valid) throw new AuthError('Access token signature is invalid.');

  const nowSec = Math.floor((options.now ?? Date.now()) / 1000);
  const skew = 60;
  if (typeof payload.exp !== 'number' || payload.exp + skew < nowSec) throw new AuthError('Access token expired.');
  if (typeof payload.nbf === 'number' && payload.nbf - skew > nowSec) throw new AuthError('Access token not yet valid.');
  if (payload.iss !== teamDomain) throw new AuthError('Access token issuer mismatch.');
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(env.ACCESS_AUD)) throw new AuthError('Access token audience mismatch.');

  // Service tokens issued by Access carry common_name instead of email.
  const actor = typeof payload.email === 'string' ? payload.email
    : typeof payload.common_name === 'string' ? payload.common_name
      : typeof payload.sub === 'string' ? payload.sub : null;
  if (!actor) throw new AuthError('Access token has no subject.');
  return { harness: 'human', actor, via: 'access', expiresAt: payload.exp * 1000 };
}

/**
 * Resolve the caller. Order: bearer service token (MCP clients), then the
 * Access assertion header (browsers). Returns null when neither is present
 * or valid; callers turn that into 401.
 */
export async function authenticate(
  request: Request,
  env: Env,
  options: { fetcher?: JwksFetcher; now?: number } = {},
): Promise<Principal | null> {
  const authorization = request.headers.get('authorization');
  if (authorization?.toLowerCase().startsWith('bearer ')) {
    const principal = await verifyServiceToken(authorization.slice(7).trim(), env);
    if (principal) return principal;
  }
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

const principalSchema = z.object({
  harness: harnessSchema,
  actor: z.string().min(1).max(200),
  via: z.enum(['access', 'service-token']),
  expiresAt: z.number().int().positive().optional(),
  tokenSha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
});

export function decodePrincipal(value: string | null): Principal | null {
  if (!value) return null;
  try {
    return principalSchema.parse(JSON.parse(value));
  } catch {
    return null;
  }
}
