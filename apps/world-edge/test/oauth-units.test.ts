import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { readAccessOidcConfig } from '../src/access-oidc.js';
import { AuthError, resetJwksCache, verifyRs256Jwt, type JwksFetcher } from '../src/auth.js';
import type { Env } from '../src/env.js';
import { harnessForClient } from '../src/harness.js';
import worker from '../src/index.js';
import { mcpHostOptions, TOOL_SCOPES } from '../src/mcp.js';
import { parsePublicOrigin, principalFromVerifiedContext, resolveOAuth } from '../src/oauth.js';
import { isRedirectAllowed, parseRedirectAllowlist } from '../src/redirect-allowlist.js';
import { testEnv, worldName } from './helpers.js';
import { signingKey } from './oauth-helpers.js';
import envSource from '../src/env.ts?raw';
import wranglerTestText from './wrangler.test.jsonc?raw';
import wranglerText from '../wrangler.jsonc?raw';

const DEFAULT_ALLOWLIST = 'https://chatgpt.com/connector_platform_oauth_redirect https://chatgpt.com/connector/oauth/* https://claude.ai/api/mcp/auth_callback';

describe('redirect allowlist', () => {
  const list = parseRedirectAllowlist(DEFAULT_ALLOWLIST);
  const withLoopback = parseRedirectAllowlist(`${DEFAULT_ALLOWLIST}, loopback`);

  it('allows the exact and prefix entries', () => {
    for (const uri of [
      'https://chatgpt.com/connector_platform_oauth_redirect',
      'https://chatgpt.com/connector/oauth/abc123',
      'https://chatgpt.com/connector/oauth/abc-123_x.y~z',
      'https://chatgpt.com/connector/oauth/a/b',
      'https://claude.ai/api/mcp/auth_callback',
    ]) expect(isRedirectAllowed(uri, list), uri).toBe(true);
  });

  it('refuses lookalike hosts, prefix tricks, ports, queries, fragments, userinfo and non-canonical spellings', () => {
    for (const uri of [
      'https://chatgpt.com.evil.com/connector_platform_oauth_redirect',
      'https://evil.com/?https://chatgpt.com/connector_platform_oauth_redirect',
      'https://evil.com/https://claude.ai/api/mcp/auth_callback',
      'https://chatgpt.com@evil.com/connector/oauth/x',
      'https://user@chatgpt.com/connector/oauth/x',
      'https://chatgpt.com:443/connector/oauth/x',
      'https://chatgpt.com:8443/connector/oauth/x',
      'https://chatgpt.com/connector/oauth',
      'https://chatgpt.com/connector/oauth/',
      'https://chatgpt.com/connector/oauthx',
      'https://chatgpt.com/connector/oauth/x/',
      'https://chatgpt.com/connector/oauth/x?next=https://evil.com',
      'https://chatgpt.com/connector/oauth/x#frag',
      'https://chatgpt.com/connector/oauth/../../evil',
      'https://chatgpt.com/connector/oauth/%2e%2e/evil',
      'https://chatgpt.com/connector/oauth/a%2Fb',
      'https://CHATGPT.com/connector_platform_oauth_redirect',
      'HTTPS://chatgpt.com/connector_platform_oauth_redirect',
      'https://chatgpt.com/connector_platform_oauth_redirect/',
      'https://chatgpt.com/connector_platform_oauth_redirect?x=1',
      'http://chatgpt.com/connector_platform_oauth_redirect',
      'https://claude.ai/api/mcp/auth_callback/x',
      'https://claude.com/api/mcp/auth_callback',
      ' https://claude.ai/api/mcp/auth_callback',
      'http://localhost:3000/callback',
      'https://chatgpt.com/connector/oauth/x?',
      'https://chatgpt.com/connector/oauth/x#',
      'https://chatgpt.com/connector/oauth/x?#',
      'https://chatgpt.com/connector_platform_oauth_redirect?',
      'https://claude.ai/api/mcp/auth_callback#',
      '',
    ]) expect(isRedirectAllowed(uri, list), uri).toBe(false);
    expect(isRedirectAllowed(42, list)).toBe(false);
  });

  it('loopback allows only http localhost and 127.0.0.1 /callback, optionally one /<id> segment', () => {
    for (const uri of [
      'http://localhost:3118/callback',
      'http://127.0.0.1:52000/callback',
      'http://localhost/callback',
      'http://127.0.0.1:1455/callback/abc123',
      'http://[::1]:3118/callback',
      'http://[::1]/callback',
      'http://[::1]:1455/callback/abc123',
    ]) expect(isRedirectAllowed(uri, withLoopback), uri).toBe(true);
    for (const uri of [
      'https://localhost:3118/callback',
      'http://localhost:3118/callbacks',
      'http://localhost:3118/callback/a/b',
      'http://localhost:3118/callback/',
      'http://localhost:3118/callback?x=1',
      'http://localhost.evil.com:3118/callback',
      'http://127.0.0.2:3118/callback',
      'https://[::1]:3118/callback',
      'http://[::1]:3118/callbacks',
      'http://[::2]:3118/callback',
      'http://[::1]:3118/callback?x=1',
      'http://evil.com/callback',
      'http://user@localhost:3118/callback',
      'http://localhost/callback?',
      'http://localhost/callback#',
      'http://127.0.0.1:1455/callback/abc?',
    ]) expect(isRedirectAllowed(uri, withLoopback), uri).toBe(false);
  });

  it('fails closed: unset, empty or invalid entries allow nothing', () => {
    for (const value of [undefined, '', '  ,  ']) {
      expect(parseRedirectAllowlist(value)).toEqual([]);
      expect(isRedirectAllowed('https://claude.ai/api/mcp/auth_callback', parseRedirectAllowlist(value))).toBe(false);
    }
    const invalid = parseRedirectAllowlist('http://claude.ai/cb https://x.example:8443/cb https://x.example/cb?q=1 https://x.example/cb? https://x.example/cb# https://x.example/a?/* https://x.example/* * https://user@x.example/cb LOOPBACK');
    expect(invalid).toEqual([]);
  });
});

describe('harness mapping', () => {
  const map = (clientId: string, redirectUri = 'https://example.com/cb') => harnessForClient({ clientId, redirectUri });

  it('maps CIMD client ids, Codex before ChatGPT', () => {
    expect(map('https://chatgpt.com/oauth/codex/client.json', 'http://127.0.0.1:1455/callback')).toBe('codex');
    expect(map('https://chatgpt.com/oauth/codex/cb_123/client.json')).toBe('codex');
    expect(map('https://chatgpt.com/oauth/client.json')).toBe('chatgpt');
    expect(map('https://chatgpt.com/oauth/cb_123/client.json')).toBe('chatgpt');
    expect(map('https://claude.ai/oauth/mcp-oauth-client-metadata')).toBe('claude-ai');
    expect(map('https://claude.ai/oauth/claude-code-client-metadata', 'http://localhost:3118/callback')).toBe('claude');
  });

  it('maps non-loopback redirect URIs when the client id is not a known CIMD URL', () => {
    expect(map('dcr-client-1', 'https://chatgpt.com/connector_platform_oauth_redirect')).toBe('chatgpt');
    expect(map('dcr-client-1', 'https://chatgpt.com/connector/oauth/cb_123')).toBe('chatgpt');
    expect(map('dcr-client-1', 'https://claude.ai/api/mcp/auth_callback')).toBe('claude-ai');
  });

  it('gives lookalikes, loopback-only and unknown clients the neutral slug', () => {
    for (const [clientId, redirectUri] of [
      ['https://chatgpt.com.evil.com/oauth/client.json', 'https://example.com/cb'],
      ['https://evil.com/?https://chatgpt.com/oauth/client.json', 'https://example.com/cb'],
      ['https://evil.com/https://chatgpt.com/oauth/client.json', 'https://example.com/cb'],
      ['https://chatgpt.com:8443/oauth/client.json', 'https://example.com/cb'],
      ['https://user@chatgpt.com/oauth/client.json', 'https://example.com/cb'],
      ['https://chatgpt.com/oauth/client.json?x=1', 'https://example.com/cb'],
      ['https://chatgpt.com/oauth/a/b/client.json', 'https://example.com/cb'],
      ['http://chatgpt.com/oauth/client.json', 'https://example.com/cb'],
      ['https://claude.ai/oauth/mcp-oauth-client-metadata/x', 'https://example.com/cb'],
      ['dcr-client-1', 'https://chatgpt.com.evil.com/connector_platform_oauth_redirect'],
      ['dcr-client-1', 'https://evil.com/?https://claude.ai/api/mcp/auth_callback'],
      ['dcr-client-1', 'https://claude.ai/api/mcp/auth_callback?x=1'],
      ['dcr-client-1', 'https://chatgpt.com/connector/oauth'],
      ['dcr-client-1', 'http://localhost:3118/callback'],
      ['dcr-client-1', 'http://127.0.0.1:1455/callback'],
      ['ChatGPT', 'https://example.com/cb'],
    ] as const) expect(harnessForClient({ clientId, redirectUri }), `${clientId} ${redirectUri}`).toBe('mcp-client');
  });
});

describe('PUBLIC_ORIGIN and lazy provider construction', () => {
  it('accepts only an exact origin', () => {
    expect(parsePublicOrigin('https://world.example.com')).toEqual({ ok: true, origin: 'https://world.example.com', host: 'world.example.com' });
    expect(parsePublicOrigin('http://localhost:8787')).toMatchObject({ ok: true, origin: 'http://localhost:8787' });
    for (const value of [
      'https://world.example.com/', 'https://world.example.com/mcp', 'https://World.example.com', 'https://world.example.com:443',
      'http://world.example.com', 'world.example.com', 'https://user@world.example.com', 'https://world.example.com?x', 'ftp://world.example.com', '',
    ]) expect(parsePublicOrigin(value).ok, value).toBe(false);
  });

  it('is off without PUBLIC_ORIGIN or OAUTH_KV, invalid on a malformed origin, on otherwise', () => {
    const env = testEnv as unknown as Env;
    expect(resolveOAuth({ ...env, PUBLIC_ORIGIN: undefined })).toEqual({ state: 'off' });
    expect(resolveOAuth({ ...env, PUBLIC_ORIGIN: '' })).toEqual({ state: 'off' });
    expect(resolveOAuth({ ...env, OAUTH_KV: undefined })).toEqual({ state: 'off' });
    expect(resolveOAuth({ ...env, PUBLIC_ORIGIN: 'https://world.example.com/' })).toMatchObject({ state: 'invalid' });
    const on = resolveOAuth(env);
    expect(on).toMatchObject({ state: 'on', origin: 'https://world-edge.test' });
    // Memoized: the same provider for the same origin and allowlist.
    expect(resolveOAuth(env)).toMatchObject({ state: 'on' });
    expect((resolveOAuth(env) as { provider: unknown }).provider).toBe((on as { provider: unknown }).provider);
  });

  async function call(env: Env, path: string, init: RequestInit = {}) {
    const ctx = createExecutionContext();
    const response = await worker.fetch(new Request(`https://world-edge.test${path}`, init), env, ctx);
    await waitOnExecutionContext(ctx);
    return response;
  }
  const mcpInit = (token?: string): RequestInit => ({
    method: 'POST',
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-06-18',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_world', arguments: { worldId: worldName('off') } } }),
  });

  it('with OAuth off, the OAuth paths are 404 and /mcp takes bearer tokens as before', async () => {
    const off = { ...testEnv, PUBLIC_ORIGIN: undefined } as unknown as Env;
    for (const path of ['/authorize', '/callback', '/token', '/register', '/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
      expect((await call(off, path)).status, path).toBe(404);
    }
    const anonymous = await call(off, '/mcp', mcpInit());
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get('www-authenticate')).toBe('Bearer realm="world-edge"');
    expect(await anonymous.json()).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
    const bearer = await call(off, '/mcp', mcpInit(testEnv.TEST_TOKENS.claude));
    expect(bearer.status).toBe(200);
  });

  it('with a malformed PUBLIC_ORIGIN, /mcp and the OAuth paths fail closed; other routes still work', async () => {
    const bad = { ...testEnv, PUBLIC_ORIGIN: 'https://world-edge.test/' } as unknown as Env;
    expect((await call(bad, '/mcp', mcpInit(testEnv.TEST_TOKENS.claude))).status).toBe(500);
    expect((await call(bad, '/authorize')).status).toBe(500);
    const agents = await call(bad, `/agents/world-agent/${worldName('bad')}`, { headers: { authorization: `Bearer ${testEnv.TEST_TOKENS.claude}` } });
    expect(agents.status).toBe(200);
    expect((await call(bad, '/health')).status).toBe(200);
  });
});

describe('principal from the provider-verified context', () => {
  const oauthProps = { kind: 'oauth', harness: 'chatgpt', actor: 'writer@example.com', sub: 'u1', clientId: 'c1' };
  const oauthAuth = { token: 't', audience: 'https://world-edge.test/mcp', scope: ['world:read', 'offline_access'], userId: 'u1', clientId: 'c1' };

  it('builds an OAuth principal with the verified scopes only', () => {
    expect(principalFromVerifiedContext(oauthProps, oauthAuth)).toEqual({ harness: 'chatgpt', actor: 'writer@example.com', via: 'oauth', scopes: ['world:read'] });
  });

  it('builds a service-token principal only for tokens the provider did not issue', () => {
    const external = { token: 't', audience: 'https://world-edge.test/mcp', scope: [] };
    expect(principalFromVerifiedContext({ kind: 'service-token', harness: 'claude', actor: 'claude-test' }, external)).toEqual({ harness: 'claude', actor: 'claude-test', via: 'service-token' });
    // An issued token's props can never make it a service token.
    expect(principalFromVerifiedContext({ kind: 'service-token', harness: 'claude', actor: 'x' }, oauthAuth)).toBeNull();
    // An external token can never become an OAuth principal.
    expect(principalFromVerifiedContext(oauthProps, external)).toBeNull();
  });

  it('refuses mismatched or malformed props', () => {
    expect(principalFromVerifiedContext({ ...oauthProps, clientId: 'other' }, oauthAuth)).toBeNull();
    expect(principalFromVerifiedContext({ ...oauthProps, harness: 'Not A Slug' }, oauthAuth)).toBeNull();
    expect(principalFromVerifiedContext({ ...oauthProps, actor: '' }, oauthAuth)).toBeNull();
    expect(principalFromVerifiedContext(undefined, oauthAuth)).toBeNull();
    expect(principalFromVerifiedContext(oauthProps, undefined)).toBeNull();
  });
});

describe('Access OIDC configuration', () => {
  const base = testEnv as unknown as Env;

  it('derives the issuer from ACCESS_TOKEN_URL', () => {
    expect(readAccessOidcConfig(base)).toMatchObject({ ok: true, config: { issuer: 'https://test-team.cloudflareaccess.com/cdn-cgi/access/sso/oidc/test-access-client' } });
  });

  it('refuses to start without every secret, or with a token URL that does not end in /token', () => {
    for (const patch of [
      { ACCESS_CLIENT_ID: undefined },
      { ACCESS_CLIENT_SECRET: '' },
      { ACCESS_TOKEN_URL: 'https://test-team.cloudflareaccess.com/cdn-cgi/access/sso/oidc/test-access-client/token/' },
      { ACCESS_TOKEN_URL: 'https://test-team.cloudflareaccess.com/cdn-cgi/access/sso/oidc/test-access-client' },
      { ACCESS_TOKEN_URL: 'https://test-team.cloudflareaccess.com/token' },
      { ACCESS_TOKEN_URL: 'http://test-team.cloudflareaccess.com/cdn-cgi/access/sso/oidc/c/token' },
      { ACCESS_TOKEN_URL: 'https://test-team.cloudflareaccess.com/cdn-cgi/access/sso/oidc/c/token?x=1' },
      { ACCESS_JWKS_URL: 'not a url' },
      { ACCESS_AUTHORIZATION_URL: undefined },
    ]) expect(readAccessOidcConfig({ ...base, ...patch }).ok, JSON.stringify(patch)).toBe(false);
  });

  it('the /authorize page refuses to start when the Access config is bad', async () => {
    const bad = { ...testEnv, ACCESS_TOKEN_URL: 'https://test-team.cloudflareaccess.com/oidc/x' } as unknown as Env;
    const ctx = createExecutionContext();
    const response = await worker.fetch(new Request('https://world-edge.test/authorize?client_id=x'), bad, ctx);
    expect(response.status).toBe(503);
    expect(response.headers.get('location')).toBeNull();
  });
});

describe('tool scopes', () => {
  it('gate reads on world:read, writes on world:write and propose_canon on world:propose', () => {
    expect(TOOL_SCOPES).toEqual({
      get_world: 'world:read', get_region: 'world:read', search: 'world:read',
      add_node: 'world:write', update_node: 'world:write', link: 'world:write', move: 'world:write',
      layout_region: 'world:write', import_whiteboard: 'world:write',
      propose_canon: 'world:propose',
    });
  });
});

describe('createMcpHandler origin options', () => {
  it('adds the public host to the default Origin allowlist', () => {
    expect(mcpHostOptions(new URL('https://world.example.com/mcp'), 'world.example.com')).toEqual({
      allowedOriginHostnames: ['world.example.com', 'localhost', '127.0.0.1', '[::1]'],
    });
    expect(mcpHostOptions(new URL('https://world-edge.acct.workers.dev/mcp'), 'world.example.com').allowedOriginHostnames).toContain('world-edge.acct.workers.dev');
  });
});

describe('verifyRs256Jwt failures are AuthErrors', () => {
  beforeEach(() => resetJwksCache());
  const JWKS = 'https://keys.test/jwks';
  const claims = () => ({ exp: Math.floor(Date.now() / 1000) + 300 });

  async function failure(promise: Promise<unknown>): Promise<AuthError> {
    const error = await promise.then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(AuthError);
    return error as AuthError;
  }

  it('a signature segment that is not base64url is a 401, not a DOMException', async () => {
    const key = await signingKey();
    const token = `${(await key.sign(claims())).split('.').slice(0, 2).join('.')}.@@@`;
    const fetcher: JwksFetcher = async () => ({ keys: [key.jwk] });
    expect((await failure(verifyRs256Jwt(token, { jwksUrl: JWKS, label: 'Test token', fetcher }))).status).toBe(401);
  });

  it('a key WebCrypto refuses for RS256 verification (use, alg, key_ops) is a 401, not a DataError', async () => {
    for (const patch of [{ use: 'enc' }, { alg: 'RS512' }, { key_ops: ['encrypt'] }, { kty: 'EC' }]) {
      resetJwksCache();
      const key = await signingKey();
      const fetcher: JwksFetcher = async () => ({ keys: [{ ...key.jwk, ...patch } as JsonWebKey] });
      expect((await failure(verifyRs256Jwt(await key.sign(claims()), { jwksUrl: JWKS, label: 'Test token', fetcher }))).status, JSON.stringify(patch)).toBe(401);
    }
  });

  it('a header or payload that is JSON but not an object is a 401', async () => {
    const enc = (v: unknown) => btoa(JSON.stringify(v)).replace(/=+$/, '');
    for (const token of [`${enc(null)}.${enc({})}.sig`, `${enc({ alg: 'RS256' })}.${enc([1])}.sig`]) {
      expect((await failure(verifyRs256Jwt(token, { jwksUrl: JWKS, label: 'Test token', fetcher: async () => ({ keys: [] }) }))).status).toBe(401);
    }
  });

  it('keys that cannot be loaded are a 503, whatever the fetcher throws', async () => {
    const key = await signingKey();
    const token = await key.sign(claims());
    for (const fetcher of [
      async () => { throw new TypeError('network down'); },
      async () => { throw new SyntaxError('Unexpected token < in JSON'); },
      async () => { throw new AuthError('Could not load Access signing keys (500).', 503); },
    ] as JwksFetcher[]) {
      resetJwksCache();
      expect((await failure(verifyRs256Jwt(token, { jwksUrl: JWKS, label: 'Test token', fetcher }))).status).toBe(503);
    }
  });

  it('an unknown kid forces at most one refetch per JWKS URL per 30 seconds', async () => {
    const known = await signingKey();
    const rotated = await signingKey();
    let published = [known.jwk];
    let fetches = 0;
    const fetcher: JwksFetcher = async () => {
      fetches += 1;
      return { keys: published };
    };
    const t0 = Date.now();
    const verify = async (key: typeof known, at: number, kid?: string) =>
      verifyRs256Jwt(await key.sign(claims(), kid ? { kid } : {}), { jwksUrl: JWKS, label: 'Test token', fetcher, now: at });

    await verify(known, t0);
    expect(fetches).toBe(1);
    // A made-up kid: one forced refetch, then none for 30 s.
    await failure(verify(known, t0 + 1000, 'bogus-1'));
    expect(fetches).toBe(2);
    for (let i = 0; i < 5; i++) await failure(verify(known, t0 + 2000 + i, `bogus-${i + 2}`));
    expect(fetches).toBe(2);
    // A real rotation inside the window waits for it to pass, then is picked up.
    published = [known.jwk, rotated.jwk];
    await failure(verify(rotated, t0 + 20_000));
    expect(fetches).toBe(2);
    await expect(verify(rotated, t0 + 31_001)).resolves.toBeTruthy();
    expect(fetches).toBe(3);
    // Another URL has its own window.
    await failure(verifyRs256Jwt(await known.sign(claims(), { kid: 'bogus-x' }), { jwksUrl: 'https://other-keys.test/jwks', label: 'Test token', fetcher, now: t0 + 31_002 }));
    expect(fetches).toBe(5);
  });

  /** A fetcher that answers after a short delay, so concurrent callers overlap, and counts calls. */
  function slowFetcher(keys: () => JsonWebKey[] | Error) {
    const counter = { calls: 0 };
    const fetcher: JwksFetcher = async () => {
      counter.calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      const result = keys();
      if (result instanceof Error) throw result;
      return { keys: result };
    };
    return { fetcher, counter };
  }

  it('after a rotation, concurrent tokens with the new kid cause one forced fetch; those inside the window get 401, later ones verify', async () => {
    const known = await signingKey();
    const rotated = await signingKey();
    let published: JsonWebKey[] = [known.jwk];
    const { fetcher, counter } = slowFetcher(() => published);
    const t0 = Date.now();
    const verify = async (key: typeof known, at: number) =>
      verifyRs256Jwt(await key.sign(claims()), { jwksUrl: JWKS, label: 'Test token', fetcher, now: at });

    await verify(known, t0);
    expect(counter.calls).toBe(1);
    published = [known.jwk, rotated.jwk];
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => verify(rotated, t0 + 1000)));
    expect(counter.calls).toBe(2);
    // The request that started the forced fetch verifies; the others are told 401 instead of waiting on it.
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(rejected).toHaveLength(19);
    expect(rejected.every((r) => r.reason instanceof AuthError && r.reason.status === 401)).toBe(true);
    // The refetched keys are cached: a retry inside the window verifies without another fetch.
    await expect(verify(rotated, t0 + 2000)).resolves.toBeTruthy();
    expect(counter.calls).toBe(2);
  });

  it('20 concurrent made-up kids cause one forced fetch', async () => {
    const known = await signingKey();
    const { fetcher, counter } = slowFetcher(() => [known.jwk]);
    const t0 = Date.now();
    await verifyRs256Jwt(await known.sign(claims()), { jwksUrl: JWKS, label: 'Test token', fetcher, now: t0 });
    const bogus = await Promise.all(Array.from({ length: 20 }, (_, i) => known.sign(claims(), { kid: `bogus-${i}` })));
    const errors = await Promise.all(bogus.map((token) => failure(verifyRs256Jwt(token, { jwksUrl: JWKS, label: 'Test token', fetcher, now: t0 + 1000 }))));
    expect(errors.every((e) => e.status === 401)).toBe(true);
    expect(counter.calls).toBe(2);
  });

  it('a failed forced fetch starts the 30 second window too', async () => {
    const known = await signingKey();
    let down = false;
    const { fetcher, counter } = slowFetcher(() => (down ? new TypeError('network down') : [known.jwk]));
    const t0 = Date.now();
    await verifyRs256Jwt(await known.sign(claims()), { jwksUrl: JWKS, label: 'Test token', fetcher, now: t0 });
    down = true;
    const first = await failure(verifyRs256Jwt(await known.sign(claims(), { kid: 'bogus-a' }), { jwksUrl: JWKS, label: 'Test token', fetcher, now: t0 + 1000 }));
    expect(first.status).toBe(503);
    expect(counter.calls).toBe(2);
    for (let i = 0; i < 10; i++) {
      const later = await failure(verifyRs256Jwt(await known.sign(claims(), { kid: `bogus-b${i}` }), { jwksUrl: JWKS, label: 'Test token', fetcher, now: t0 + 2000 + i * 1000 }));
      expect(later.status).toBe(401);
    }
    expect(counter.calls).toBe(2);
    // The window over, the next unknown kid tries again.
    await failure(verifyRs256Jwt(await known.sign(claims(), { kid: 'bogus-c' }), { jwksUrl: JWKS, label: 'Test token', fetcher, now: t0 + 31_001 }));
    expect(counter.calls).toBe(3);
  });
});

/** Parse JSONC: drop line and block comments outside strings, then trailing commas. */
function parseJsonc(text: string): Record<string, unknown> {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inString) {
      out += c;
      if (c === '\\') out += text[++i] ?? '';
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2) + 1;
    } else {
      out += c;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1')) as Record<string, unknown>;
}

describe('configuration files agree with the code', () => {
  const config = parseJsonc(wranglerText) as {
    compatibility_flags: string[];
    kv_namespaces: { binding: string }[];
    vars: Record<string, string>;
    secrets: { required: string[] };
  };
  const testConfig = parseJsonc(wranglerTestText) as typeof config;

  it('secrets.required lists exactly the secret fields of Env', () => {
    const secrets = [...envSource.matchAll(/\/\*\*([\s\S]*?)\*\/\s*([A-Z][A-Z0-9_]*)\??\s*:/g)]
      .filter((m) => /\bSecret\./.test(m[1]!))
      .map((m) => m[2]!);
    expect(secrets.length).toBe(7);
    expect([...config.secrets.required].sort()).toEqual([...secrets].sort());
  });

  it('the test config mirrors the OAuth bindings, flags and default allowlist', () => {
    expect(testConfig.vars.OAUTH_REDIRECT_ALLOWLIST).toBe(config.vars.OAUTH_REDIRECT_ALLOWLIST);
    expect(config.vars.OAUTH_REDIRECT_ALLOWLIST).toBe(DEFAULT_ALLOWLIST);
    for (const c of [config, testConfig]) {
      expect(c.compatibility_flags).toEqual(expect.arrayContaining(['nodejs_compat', 'global_fetch_strictly_public']));
      expect(c.kv_namespaces.map((k) => k.binding)).toContain('OAUTH_KV');
    }
    expect(config.vars).toHaveProperty('PUBLIC_ORIGIN');
  });
});
