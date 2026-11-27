import { AuthError, verifyRs256Jwt, type JwksFetcher } from './auth.js';
import type { Env } from './env.js';

/**
 * Cloudflare Access for SaaS (OIDC) as the identity step of the OAuth flow.
 * The Worker is an OIDC client of an Access for SaaS application whose
 * redirect URL is `${PUBLIC_ORIGIN}/callback`; Access policies decide who may
 * sign in. Cloudflare documents the endpoints as
 *   issuer          https://<team>.cloudflareaccess.com/cdn-cgi/access/sso/oidc/<client_id>
 *   token endpoint  <issuer>/token
 *   authorization   <issuer>/authorization
 *   keys            <issuer>/jwks
 * The issuer is derived from ACCESS_TOKEN_URL by removing "/token".
 */

export interface AccessOidcConfig {
  clientId: string;
  clientSecret: string;
  authorizationUrl: string;
  tokenUrl: string;
  jwksUrl: string;
  /** Expected id_token `iss`: ACCESS_TOKEN_URL without its trailing "/token". */
  issuer: string;
}

export type AccessOidcConfigResult = { ok: true; config: AccessOidcConfig } | { ok: false; reason: string };

function httpsUrl(value: string | undefined): URL | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) return null;
    return url;
  } catch {
    return null;
  }
}

/** Read and check the Access secrets. The flow refuses to start unless this is ok. */
export function readAccessOidcConfig(env: Env): AccessOidcConfigResult {
  const clientId = env.ACCESS_CLIENT_ID?.trim();
  const clientSecret = env.ACCESS_CLIENT_SECRET;
  if (!clientId || !clientSecret) return { ok: false, reason: 'ACCESS_CLIENT_ID and ACCESS_CLIENT_SECRET must be set.' };
  const tokenUrl = httpsUrl(env.ACCESS_TOKEN_URL);
  const authorizationUrl = httpsUrl(env.ACCESS_AUTHORIZATION_URL);
  const jwksUrl = httpsUrl(env.ACCESS_JWKS_URL);
  if (!tokenUrl || !authorizationUrl || !jwksUrl) {
    return { ok: false, reason: 'ACCESS_TOKEN_URL, ACCESS_AUTHORIZATION_URL and ACCESS_JWKS_URL must be https URLs without query or fragment.' };
  }
  const token = env.ACCESS_TOKEN_URL!;
  if (!token.endsWith('/token') || token !== tokenUrl.href) {
    return { ok: false, reason: 'ACCESS_TOKEN_URL must be the Access token endpoint ending in /token.' };
  }
  const issuer = token.slice(0, -'/token'.length);
  if (!httpsUrl(issuer) || new URL(issuer).pathname === '/') return { ok: false, reason: 'ACCESS_TOKEN_URL does not yield an issuer.' };
  return {
    ok: true,
    config: {
      clientId,
      clientSecret,
      authorizationUrl: authorizationUrl.href,
      tokenUrl: token,
      jwksUrl: jwksUrl.href,
      issuer,
    },
  };
}

function base64Url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 32 random bytes, base64url: a PKCE verifier (RFC 7636, 43 chars) or a nonce. */
export function randomToken(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

/** The URL that sends the browser to Access to sign in. */
export function accessAuthorizeUrl(
  config: AccessOidcConfig,
  params: { redirectUri: string; state: string; nonce: string; codeChallenge: string },
): string {
  const url = new URL(config.authorizationUrl);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid email profile');
  url.searchParams.set('state', params.state);
  url.searchParams.set('nonce', params.nonce);
  url.searchParams.set('code_challenge', params.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.href;
}

export class UpstreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UpstreamError';
  }
}

/**
 * Exchange the Access authorization code for tokens and return the id_token.
 *
 * Client authentication is client_secret_post (client_id and client_secret in
 * the form body). That is our assumption: Cloudflare's docs do not state the
 * method. If Access needs client_secret_basic, change only this function.
 */
export async function exchangeAccessCode(
  config: AccessOidcConfig,
  params: { code: string; redirectUri: string; codeVerifier: string },
): Promise<string> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: params.code,
    redirect_uri: params.redirectUri,
    code_verifier: params.codeVerifier,
    client_id: config.clientId,
    client_secret: config.clientSecret,
  });
  let response: Response;
  try {
    response = await fetch(config.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body,
      redirect: 'manual',
    });
  } catch {
    throw new UpstreamError('Access token endpoint unreachable.');
  }
  if (!response.ok) throw new UpstreamError(`Access token endpoint answered ${response.status}.`);
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new UpstreamError('Access token response is not JSON.');
  }
  const idToken = (json as { id_token?: unknown } | null)?.id_token;
  if (typeof idToken !== 'string' || idToken.length === 0) throw new UpstreamError('Access token response has no id_token.');
  return idToken;
}

export interface AccessIdentity {
  sub: string;
  email: string;
}

/**
 * Verify the Access id_token: RS256 with a key from ACCESS_JWKS_URL chosen by
 * kid, iss equal to the derived issuer, aud containing ACCESS_CLIENT_ID,
 * exp/nbf with 60 s skew, nonce equal to the one stored before the redirect,
 * and non-empty string sub and email. Throws AuthError on any failure.
 */
export async function verifyAccessIdToken(
  idToken: string,
  config: AccessOidcConfig,
  expected: { nonce: string },
  options: { fetcher?: JwksFetcher; now?: number } = {},
): Promise<AccessIdentity> {
  const payload = await verifyRs256Jwt(idToken, {
    jwksUrl: config.jwksUrl,
    label: 'Access id_token',
    requireKid: true,
    fetcher: options.fetcher,
    now: options.now,
  });
  if (payload.iss !== config.issuer) throw new AuthError('Access id_token issuer mismatch.');
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(config.clientId)) throw new AuthError('Access id_token audience mismatch.');
  if (typeof payload.nonce !== 'string' || payload.nonce !== expected.nonce) throw new AuthError('Access id_token nonce mismatch.');
  const { sub, email } = payload;
  if (typeof sub !== 'string' || sub.trim().length === 0 || sub.length > 255) throw new AuthError('Access id_token has no usable sub.');
  if (typeof email !== 'string' || email.trim().length === 0 || email.length > 200) throw new AuthError('Access id_token has no usable email.');
  return { sub, email };
}
