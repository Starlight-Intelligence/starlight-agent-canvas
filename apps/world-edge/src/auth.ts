import { harnessSchema } from '@starlight-agent-canvas/world';
import { z } from 'zod';
import type { Env } from './env.js';

/**
 * Authenticated caller. Every write records `harness` and `actor` in the
 * ops_log. Built only by `authenticate` or `authenticateMcp`; never parsed
 * from client JSON.
 */
export interface Principal {
  /** human for browsers behind Access; claude, codex, chatgpt ... for service tokens. */
  harness: string;
  /** Stable id: Access identity email, or the service token name. */
  actor: string;
  via: 'access' | 'service-token';
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

export async function verifyServiceToken(token: string, env: Pick<Env, 'MCP_SERVICE_TOKENS'>): Promise<Principal | null> {
  if (!env.MCP_SERVICE_TOKENS || token.length < 16 || token.length > 512) return null;
  let entries: z.infer<typeof serviceTokensSchema>;
  try {
    entries = serviceTokensSchema.parse(JSON.parse(env.MCP_SERVICE_TOKENS));
  } catch {
    // Misconfigured secret: fail closed. Do not echo the secret.
    return null;
  }
  const presented = await sha256Hex(token);
  let match: (typeof entries)[number] | null = null;
  for (const entry of entries) {
    if (timingSafeEqualHex(presented, entry.sha256)) match = entry;
  }
  return match ? { harness: match.harness, actor: match.name, via: 'service-token' } : null;
}

// ---------------------------------------------------------------------------
// Cloudflare Access JWT (Cf-Access-Jwt-Assertion), RS256, keys from
// <team domain>/cdn-cgi/access/certs.
// ---------------------------------------------------------------------------

interface Jwk extends JsonWebKey {
  kid?: string;
}

let jwksCache: { url: string; keys: Jwk[]; fetchedAt: number } | null = null;
const JWKS_TTL_MS = 10 * 60 * 1000;

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

async function loadKeys(teamDomain: string, fetcher: JwksFetcher, forceRefresh: boolean): Promise<Jwk[]> {
  const url = `${teamDomain}/cdn-cgi/access/certs`;
  const now = Date.now();
  if (!forceRefresh && jwksCache && jwksCache.url === url && now - jwksCache.fetchedAt < JWKS_TTL_MS) return jwksCache.keys;
  const { keys } = await fetcher(url);
  jwksCache = { url, keys: Array.isArray(keys) ? keys : [], fetchedAt: now };
  return jwksCache.keys;
}

/** Test hook. */
export function resetJwksCache(): void {
  jwksCache = null;
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
  let keys = await loadKeys(teamDomain, fetcher, false);
  let jwk = keys.find((key) => key.kid === header.kid);
  if (!jwk) {
    // Key rotation: refresh once.
    keys = await loadKeys(teamDomain, fetcher, true);
    jwk = keys.find((key) => key.kid === header.kid);
  }
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

  // Only a browser identity (email) is a human. Access also signs a JWT for
  // requests that carry an Access service token (CF-Access-Client-Id/Secret);
  // that JWT has common_name and no email. It names no person and no harness,
  // so it never becomes a principal.
  if (typeof payload.common_name === 'string' || typeof payload.email !== 'string' || payload.email.length === 0) {
    throw new AuthError('Access service-token assertions are not accepted; use a bearer token.');
  }
  return { harness: 'human', actor: payload.email, via: 'access' };
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

const principalSchema = z.object({
  harness: harnessSchema,
  actor: z.string().min(1).max(200),
  via: z.enum(['access', 'service-token']),
});

export function decodePrincipal(value: string | null): Principal | null {
  if (!value) return null;
  try {
    return principalSchema.parse(JSON.parse(value));
  } catch {
    return null;
  }
}
