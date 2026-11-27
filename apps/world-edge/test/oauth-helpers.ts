import { SELF } from 'cloudflare:test';
import { vi } from 'vitest';

/** Values from vitest.config.ts and test/wrangler.test.jsonc. */
export const ORIGIN = 'https://world-edge.test';
export const RESOURCE = `${ORIGIN}/mcp`;
export const ACCESS_CLIENT_ID = 'test-access-client';
export const ACCESS_ISSUER = 'https://test-team.cloudflareaccess.com/cdn-cgi/access/sso/oidc/test-access-client';
export const ACCESS_TOKEN_URL = `${ACCESS_ISSUER}/token`;
export const ACCESS_AUTHORIZATION_URL = `${ACCESS_ISSUER}/authorization`;
export const ACCESS_JWKS_URL = `${ACCESS_ISSUER}/jwks`;

export const CLAUDE_AI_CALLBACK = 'https://claude.ai/api/mcp/auth_callback';
export const CHATGPT_CIMD = 'https://chatgpt.com/oauth/client.json';
export const CHATGPT_REDIRECT = 'https://chatgpt.com/connector_platform_oauth_redirect';

export function b64url(bytes: Uint8Array | string): string {
  const raw = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
  let s = '';
  for (const b of raw) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function s256(value: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))));
}

export function randomString(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(32)));
}

/** An RS256 signing key with a fresh kid. */
export async function signingKey() {
  const pair = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const kid = `k-${crypto.randomUUID()}`;
  const jwk = { ...((await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey), kid };
  return {
    kid,
    jwk,
    async sign(payload: Record<string, unknown>, header: Record<string, unknown> = {}) {
      const head = b64url(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT', ...header }));
      const body = b64url(JSON.stringify(payload));
      const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(`${head}.${body}`));
      return `${head}.${body}.${b64url(new Uint8Array(sig))}`;
    },
  };
}
export type SigningKey = Awaited<ReturnType<typeof signingKey>>;

/** Minimal cookie jar: enough to carry the provider's __Host- binding cookies between requests. */
export class CookieJar {
  readonly cookies = new Map<string, string>();
  absorb(response: Response): void {
    for (const line of response.headers.getSetCookie()) {
      const [pair, ...attributes] = line.split(';');
      const eq = pair!.indexOf('=');
      const name = pair!.slice(0, eq).trim();
      const value = pair!.slice(eq + 1).trim();
      if (value === '' || attributes.some((a) => /^\s*max-age=0\s*$/i.test(a))) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
  header(): Record<string, string> {
    return this.cookies.size ? { cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ') } : {};
  }
}

export interface AccessTokenRequest {
  form: URLSearchParams;
}

/**
 * The upstream world for one test: Access token endpoint, Access JWKS and any
 * CIMD documents, answered by a spy on globalThis.fetch. SELF runs the Worker
 * in this isolate, so the spy sees its outbound fetches; every other URL
 * passes through. Restore with vi.restoreAllMocks() after each test.
 */
export function mockUpstream(options: {
  key: SigningKey;
  /** id_token claims for the next Access token request, given the request form. */
  idToken?: (form: URLSearchParams) => Promise<string>;
  cimd?: Record<string, unknown>;
}) {
  const tokenRequests: AccessTokenRequest[] = [];
  const cimdFetches: string[] = [];
  const realFetch = globalThis.fetch;
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const url = request.url;
    if (url === ACCESS_TOKEN_URL && request.method === 'POST') {
      const form = new URLSearchParams(await request.text());
      tokenRequests.push({ form });
      if (!options.idToken) return Response.json({ error: 'invalid_grant' }, { status: 400 });
      return Response.json({ access_token: 'access-at', token_type: 'bearer', expires_in: 300, id_token: await options.idToken(form) });
    }
    if (url === ACCESS_JWKS_URL) return Response.json({ keys: [options.key.jwk] });
    if (options.cimd && url in options.cimd) {
      cimdFetches.push(url);
      return Response.json(options.cimd[url], { headers: { 'cache-control': 'no-store' } });
    }
    return realFetch(input, init);
  });
  return { spy, tokenRequests, cimdFetches };
}

/** Standard id_token claims from Access for the nonce the Worker sent. */
export function accessClaims(nonce: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return { iss: ACCESS_ISSUER, aud: [ACCESS_CLIENT_ID], sub: 'access-user-1', email: 'writer@example.com', nonce, iat: now, exp: now + 300, ...extra };
}

export async function registerClient(metadata: Record<string, unknown>): Promise<Response> {
  return SELF.fetch(`${ORIGIN}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], ...metadata }),
  });
}

export function chatgptCimdDocument(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    client_id: CHATGPT_CIMD,
    client_name: 'ChatGPT',
    redirect_uris: [CHATGPT_REDIRECT],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    ...overrides,
  };
}

export interface FlowStart {
  jar: CookieJar;
  clientId: string;
  redirectUri: string;
  verifier: string;
  clientState: string;
}

export function authorizeUrl(params: { clientId: string; redirectUri: string; challenge?: string; scope?: string; state?: string; resource?: string }): string {
  const url = new URL(`${ORIGIN}/authorize`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', params.clientId);
  url.searchParams.set('redirect_uri', params.redirectUri);
  if (params.challenge) {
    url.searchParams.set('code_challenge', params.challenge);
    url.searchParams.set('code_challenge_method', 'S256');
  }
  url.searchParams.set('scope', params.scope ?? 'world:read world:write');
  url.searchParams.set('state', params.state ?? 'client-state-123');
  url.searchParams.set('resource', params.resource ?? RESOURCE);
  return url.href;
}

/** GET /authorize. Returns the consent page response and the form handle in it. */
export async function openConsent(params: { clientId: string; redirectUri: string; scope?: string }) {
  const jar = new CookieJar();
  const verifier = randomString();
  const clientState = `state-${crypto.randomUUID()}`;
  const response = await SELF.fetch(
    authorizeUrl({ ...params, challenge: await s256(verifier), state: clientState }),
    { redirect: 'manual' },
  );
  jar.absorb(response);
  const html = await response.text();
  const handle = /name="handle" value="([^"]+)"/.exec(html)?.[1] ?? null;
  return { response, html, handle, start: { jar, clientId: params.clientId, redirectUri: params.redirectUri, verifier, clientState } satisfies FlowStart };
}

export async function postConsent(start: FlowStart, handle: string, decision: 'approve' | 'deny', scopes: string[]) {
  const form = new URLSearchParams({ handle, decision });
  for (const scope of scopes) form.append('scope', scope);
  const response = await SELF.fetch(`${ORIGIN}/authorize`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...start.jar.header() },
    body: form.toString(),
    redirect: 'manual',
  });
  start.jar.absorb(response);
  return response;
}

/** Consent approved: returns the Access redirect's parameters. */
export async function approveToAccess(params: { clientId: string; redirectUri: string; scope?: string; approve?: string[] }) {
  const consent = await openConsent(params);
  if (consent.response.status !== 200 || !consent.handle) throw new Error(`consent page failed: ${consent.response.status} ${consent.html.slice(0, 300)}`);
  const response = await postConsent(consent.start, consent.handle, 'approve', params.approve ?? ['world:read', 'world:write']);
  const location = response.headers.get('location');
  if (response.status !== 302 || !location) throw new Error(`approve failed: ${response.status} ${await response.text()}`);
  return { start: consent.start, accessRedirect: new URL(location), consentHtml: consent.html };
}

export async function callback(start: FlowStart, query: Record<string, string>) {
  const url = new URL(`${ORIGIN}/callback`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const response = await SELF.fetch(url, { headers: start.jar.header(), redirect: 'manual' });
  start.jar.absorb(response);
  return response;
}

export async function tokenRequest(fields: Record<string, string>, headers: Record<string, string> = {}) {
  const response = await SELF.fetch(`${ORIGIN}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(fields).toString(),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

export async function mcp(token: string | null, method: string, params: Record<string, unknown> = {}) {
  const response = await SELF.fetch(`${ORIGIN}/mcp`, {
    method: 'POST',
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-06-18',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const text = await response.text();
  if (response.status !== 200) return { status: response.status, headers: response.headers, text, body: null, tool: null };
  const dataLine = text.split('\n').find((line) => line.startsWith('data:'));
  const body = JSON.parse(dataLine ? dataLine.slice(5) : text) as { result?: { content?: { text: string }[]; isError?: boolean }; error?: unknown };
  const toolText = body.result?.content?.[0]?.text;
  let tool: Record<string, unknown> | null = null;
  try {
    tool = toolText ? (JSON.parse(toolText) as Record<string, unknown>) : null;
  } catch {
    // Not JSON: e.g. the MCP SDK's "Input validation error: ..." text.
  }
  return { status: response.status, headers: response.headers, text, body, tool };
}
