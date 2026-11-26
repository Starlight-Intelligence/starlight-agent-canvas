import { SELF } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authenticate, authenticateMcp, resetJwksCache, verifyAccessJwt, verifyServiceToken, type JwksFetcher } from '../src/auth.js';
import type { Env } from '../src/env.js';
import { agentFor, bearer, testEnv, worldName } from './helpers.js';

const TEAM = 'https://test-team.cloudflareaccess.com';
const AUD = 'test-aud';

function b64url(bytes: Uint8Array | string): string {
  const raw = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
  let s = '';
  for (const b of raw) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function keypair() {
  const pair = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey;
  return { pair, jwk: { ...jwk, kid: 'k1' } };
}

async function sign(privateKey: CryptoKey, payload: Record<string, unknown>, kid = 'k1') {
  const head = b64url(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(new Uint8Array(sig))}`;
}

describe('Access JWT verification', () => {
  beforeEach(() => resetJwksCache());
  const accessEnv = { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD };

  it('accepts a valid assertion and maps it to a human principal', async () => {
    const { pair, jwk } = await keypair();
    const fetcher: JwksFetcher = async () => ({ keys: [jwk] });
    const now = Math.floor(Date.now() / 1000);
    const token = await sign(pair.privateKey, { iss: TEAM, aud: [AUD], email: 'frank@example.com', exp: now + 600, iat: now });
    await expect(verifyAccessJwt(token, accessEnv, { fetcher })).resolves.toEqual({ harness: 'human', actor: 'frank@example.com', via: 'access' });
  });

  it('rejects wrong audience, wrong issuer, expiry, unknown key and tampering', async () => {
    const { pair, jwk } = await keypair();
    const fetcher: JwksFetcher = async () => ({ keys: [jwk] });
    const now = Math.floor(Date.now() / 1000);
    const good = { iss: TEAM, aud: [AUD], email: 'frank@example.com', exp: now + 600 };
    await expect(verifyAccessJwt(await sign(pair.privateKey, { ...good, aud: ['other'] }), accessEnv, { fetcher })).rejects.toThrow(/audience/);
    await expect(verifyAccessJwt(await sign(pair.privateKey, { ...good, iss: 'https://evil.cloudflareaccess.com' }), accessEnv, { fetcher })).rejects.toThrow(/issuer/);
    await expect(verifyAccessJwt(await sign(pair.privateKey, { ...good, exp: now - 3600 }), accessEnv, { fetcher })).rejects.toThrow(/expired/);
    await expect(verifyAccessJwt(await sign(pair.privateKey, good, 'k2'), accessEnv, { fetcher })).rejects.toThrow(/unknown key/);
    const token = await sign(pair.privateKey, good);
    const [h, , s] = token.split('.');
    const forged = `${h}.${b64url(JSON.stringify({ ...good, email: 'mallory@example.com' }))}.${s}`;
    await expect(verifyAccessJwt(forged, accessEnv, { fetcher })).rejects.toThrow(/signature/);
  });

  it('authenticate returns null for a bad assertion instead of throwing', async () => {
    const request = new Request('https://x/mcp', { headers: { 'cf-access-jwt-assertion': 'a.b.c' } });
    await expect(authenticate(request, { ...accessEnv } as Env, { fetcher: async () => ({ keys: [] }) })).resolves.toBeNull();
  });
});

describe('service tokens', () => {
  it('maps a known token to its harness and rejects unknown ones', async () => {
    await expect(verifyServiceToken(testEnv.TEST_TOKENS.claude, testEnv)).resolves.toEqual({ harness: 'claude', actor: 'claude-test', via: 'service-token' });
    await expect(verifyServiceToken('not-a-real-token-at-all', testEnv)).resolves.toBeNull();
    await expect(verifyServiceToken(testEnv.TEST_TOKENS.claude, { MCP_SERVICE_TOKENS: 'not json' })).resolves.toBeNull();
    await expect(verifyServiceToken(testEnv.TEST_TOKENS.claude, {})).resolves.toBeNull();
  });
});

describe('Worker rejects requests without a principal', () => {
  const routes: [string, RequestInit][] = [
    ['/mcp', { method: 'POST', body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}', headers: { 'content-type': 'application/json' } }],
    ['/agents/world-agent/arcanea', { method: 'GET' }],
    ['/agents/world-agent/arcanea/ops', { method: 'POST', body: '{"ops":[]}', headers: { 'content-type': 'application/json' } }],
    ['/media/sign', { method: 'POST', body: '{}' }],
    ['/media/object/worlds/arcanea/media/x.png', { method: 'GET' }],
  ];

  for (const [path, init] of routes) {
    it(`401 for ${init.method} ${path}`, async () => {
      const response = await SELF.fetch(`https://world-edge.test${path}`, init);
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
    });
  }

  it('401 for a wrong bearer token', async () => {
    const response = await SELF.fetch('https://world-edge.test/agents/world-agent/arcanea', { headers: bearer('wrong-token-wrong-token') });
    expect(response.status).toBe(401);
  });

  it('ignores a spoofed internal principal header', async () => {
    const response = await SELF.fetch('https://world-edge.test/agents/world-agent/arcanea/ops', {
      method: 'POST',
      headers: { 'x-world-principal': JSON.stringify({ harness: 'human', actor: 'mallory', via: 'access' }), 'content-type': 'application/json' },
      body: JSON.stringify({ ops: [{ op: 'addNode', node: { id: 'n_x', kind: 'note', title: 'x', position: { x: 0, y: 0 } } }] }),
    });
    expect(response.status).toBe(401);
  });

  it('health needs no auth', async () => {
    const response = await SELF.fetch('https://world-edge.test/health');
    expect(response.status).toBe(200);
  });

  it('accepts an authenticated HTTP write and returns 409 on stale versions', async () => {
    const worldId = worldName('http');
    const url = `https://world-edge.test/agents/world-agent/${worldId}/ops`;
    const init = (ops: unknown[]) => ({ method: 'POST', headers: { ...bearer(testEnv.TEST_TOKENS.claude), 'content-type': 'application/json' }, body: JSON.stringify({ ops }) });
    const created = await SELF.fetch(url, init([{ op: 'addNode', node: { id: 'n_x', kind: 'note', title: 'x', position: { x: 0, y: 0 } } }]));
    expect(created.status).toBe(200);
    const stale = await SELF.fetch(url, init([{ op: 'updateNode', id: 'n_x', baseVersion: 3, patch: { title: 'y' } }]));
    expect(stale.status).toBe(409);
  });
});

describe('signed media upload', () => {
  it('signs for an authenticated caller, accepts the upload once, and rejects tampering', async () => {
    const sign = await SELF.fetch('https://world-edge.test/media/sign', {
      method: 'POST',
      headers: { ...bearer(testEnv.TEST_TOKENS.claude), 'content-type': 'application/json' },
      body: JSON.stringify({ worldId: 'arcanea', filename: 'Gate Map.PNG', contentType: 'image/png' }),
    });
    expect(sign.status).toBe(200);
    const { uploadUrl, key } = (await sign.json()) as { uploadUrl: string; key: string };
    expect(key).toMatch(/^worlds\/arcanea\/media\/[a-z0-9]+-gate-map\.png$/);

    const bytes = new Uint8Array([137, 80, 78, 71]);
    const tampered = new URL(uploadUrl);
    tampered.searchParams.set('ct', 'text/plain');
    expect((await SELF.fetch(tampered, { method: 'PUT', headers: { 'content-type': 'text/plain', 'content-length': '4' }, body: bytes })).status).toBe(403);

    const put = await SELF.fetch(uploadUrl, { method: 'PUT', headers: { 'content-type': 'image/png', 'content-length': '4' }, body: bytes });
    expect(put.status).toBe(200);
    const again = await SELF.fetch(uploadUrl, { method: 'PUT', headers: { 'content-type': 'image/png', 'content-length': '4' }, body: bytes });
    expect(again.status).toBe(409);

    const read = await SELF.fetch(`https://world-edge.test/media/object/${key}`, { headers: bearer(testEnv.TEST_TOKENS.claude) });
    expect(read.status).toBe(200);
    expect(new Uint8Array(await read.arrayBuffer())).toEqual(bytes);
  });
});

// ---------------------------------------------------------------------------
// Access service-token JWTs and /mcp. When an Access Service Auth policy sits
// in front of the Worker, Access signs a JWT (common_name, no email) for any
// request carrying the Access service token. That JWT must never become a
// principal, and no Access JWT may authenticate /mcp.
// ---------------------------------------------------------------------------

const CERTS_URL = `${TEAM}/cdn-cgi/access/certs`;

/**
 * Serve the Access signing keys to the Worker. SELF runs the Worker in this
 * isolate, so a spy on globalThis.fetch sees its JWKS request to the team
 * domain from test/wrangler.test.jsonc. Every other URL passes through.
 * `keys: null` simulates the certs endpoint being down.
 */
function serveAccessCerts(keys: JsonWebKey[] | null) {
  const realFetch = globalThis.fetch;
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === CERTS_URL) return keys ? Response.json({ keys }) : new Response('unavailable', { status: 500 });
    return realFetch(input, init);
  });
}

async function accessTokens() {
  const { pair, jwk } = await keypair();
  const now = Math.floor(Date.now() / 1000);
  const base = { iss: TEAM, aud: [AUD], exp: now + 600, iat: now, type: 'app' };
  return {
    jwk,
    /** What Access issues for CF-Access-Client-Id/Secret: common_name, empty sub, no email. */
    serviceJwt: await sign(pair.privateKey, { ...base, common_name: 'abc123.access', sub: '' }),
    /** A browser identity behind Access. */
    identityJwt: await sign(pair.privateKey, { ...base, email: 'frank@example.com', sub: 'user-1' }),
    sign: (payload: Record<string, unknown>) => sign(pair.privateKey, { ...base, ...payload }),
  };
}

const MCP_HEADERS = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' };

function mcpPost(headers: Record<string, string>, method: string, params: Record<string, unknown> = {}) {
  return SELF.fetch('https://world-edge.test/mcp', {
    method: 'POST',
    headers: { ...MCP_HEADERS, ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
}

function addNodeParams(worldId: string) {
  return { name: 'add_node', arguments: { worldId, node: { kind: 'place', title: 'Intruder Gate', position: { x: 0, y: 0 } } } };
}

async function nodeCount(worldId: string): Promise<number> {
  const info = await (await agentFor(worldId)).getWorldInfo();
  return info.counts.nodes;
}

describe('Access JWT principal mapping', () => {
  beforeEach(() => resetJwksCache());
  const accessEnv = { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD };

  it('rejects a validly signed Access service-token JWT instead of mapping it to human', async () => {
    const t = await accessTokens();
    const fetcher: JwksFetcher = async () => ({ keys: [t.jwk] });
    await expect(verifyAccessJwt(t.serviceJwt, accessEnv, { fetcher })).rejects.toThrow(/service-token/);
  });

  it('rejects JWTs without a non-empty email, or with common_name, even if sub is set', async () => {
    const t = await accessTokens();
    const fetcher: JwksFetcher = async () => ({ keys: [t.jwk] });
    for (const payload of [
      { sub: 'user-1' },
      { email: '', sub: 'user-1' },
      { email: 42, sub: 'user-1' },
      { email: 'frank@example.com', common_name: 'abc123.access' },
    ]) {
      await expect(verifyAccessJwt(await t.sign(payload), accessEnv, { fetcher })).rejects.toThrow(/service-token/);
    }
  });

  it('authenticate returns null for a service-token JWT and human for an identity JWT', async () => {
    const t = await accessTokens();
    const fetcher: JwksFetcher = async () => ({ keys: [t.jwk] });
    const env = { ...testEnv, ...accessEnv } as unknown as Env;
    const at = (jwt: string) => new Request('https://x/agents/world-agent/a', { headers: { 'cf-access-jwt-assertion': jwt } });
    await expect(authenticate(at(t.serviceJwt), env, { fetcher })).resolves.toBeNull();
    await expect(authenticate(at(t.identityJwt), env, { fetcher })).resolves.toEqual({ harness: 'human', actor: 'frank@example.com', via: 'access' });
  });

  it('authenticateMcp accepts only a bearer service token and never reads Access JWTs', async () => {
    const t = await accessTokens();
    const env = testEnv as unknown as Env;
    const req = (headers: Record<string, string>) => new Request('https://x/mcp', { method: 'POST', headers });
    await expect(authenticateMcp(req({ 'cf-access-jwt-assertion': t.identityJwt }), env)).resolves.toBeNull();
    await expect(authenticateMcp(req({ 'cf-access-jwt-assertion': t.serviceJwt }), env)).resolves.toBeNull();
    await expect(authenticateMcp(req({ authorization: 'Bearer wrong-token-wrong-token', 'cf-access-jwt-assertion': t.identityJwt }), env)).resolves.toBeNull();
    await expect(authenticateMcp(req({ authorization: `Bearer ${testEnv.TEST_TOKENS.claude}`, 'cf-access-jwt-assertion': t.identityJwt }), env))
      .resolves.toEqual({ harness: 'claude', actor: 'claude-test', via: 'service-token' });
  });
});

describe('Worker routing: /mcp takes only a bearer token', () => {
  beforeEach(() => resetJwksCache());
  afterEach(() => vi.restoreAllMocks());

  it('401 for an Access service-token JWT alone on POST /mcp (tools/list and add_node), nothing written', async () => {
    const t = await accessTokens();
    serveAccessCerts([t.jwk]);
    const listed = await mcpPost({ 'cf-access-jwt-assertion': t.serviceJwt }, 'tools/list');
    expect(listed.status).toBe(401);
    expect(await listed.json()).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });

    const worldId = worldName('svcjwt');
    const added = await mcpPost({ 'cf-access-jwt-assertion': t.serviceJwt }, 'tools/call', addNodeParams(worldId));
    expect(added.status).toBe(401);
    expect(await nodeCount(worldId)).toBe(0);
  });

  it('401 for a browser identity JWT alone on POST /mcp, nothing written', async () => {
    const t = await accessTokens();
    serveAccessCerts([t.jwk]);
    expect((await mcpPost({ 'cf-access-jwt-assertion': t.identityJwt }, 'tools/list')).status).toBe(401);
    const worldId = worldName('idjwt');
    expect((await mcpPost({ 'cf-access-jwt-assertion': t.identityJwt }, 'tools/call', addNodeParams(worldId))).status).toBe(401);
    expect(await nodeCount(worldId)).toBe(0);
  });

  it('401 for a wrong bearer plus a valid Access JWT on POST /mcp (no fallback)', async () => {
    const t = await accessTokens();
    serveAccessCerts([t.jwk]);
    for (const jwt of [t.identityJwt, t.serviceJwt]) {
      const worldId = worldName('fallback');
      const response = await mcpPost({ ...bearer('wrong-token-wrong-token') as Record<string, string>, 'cf-access-jwt-assertion': jwt }, 'tools/call', addNodeParams(worldId));
      expect(response.status).toBe(401);
      expect(await nodeCount(worldId)).toBe(0);
    }
  });

  it('a valid bearer on /mcp still works and its harness wins over any Access JWT', async () => {
    const t = await accessTokens();
    serveAccessCerts([t.jwk]);
    const worldId = worldName('bearer');
    const response = await mcpPost(
      { ...bearer(testEnv.TEST_TOKENS.codex) as Record<string, string>, 'cf-access-jwt-assertion': t.identityJwt },
      'tools/call',
      addNodeParams(worldId),
    );
    expect(response.status).toBe(200);
    const text = await response.text();
    const data = text.split('\n').find((line) => line.startsWith('data:'));
    const body = JSON.parse(data ? data.slice(5) : text) as { result: { content: { text: string }[] } };
    const result = JSON.parse(body.result.content[0]!.text) as { ok: boolean; nodes: { createdBy: { harness: string; actor?: string } }[] };
    expect(result.ok).toBe(true);
    expect(result.nodes[0]!.createdBy).toMatchObject({ harness: 'codex', actor: 'codex-test' });
  });
});

describe('Worker routing: non-MCP routes accept browser identities only', () => {
  beforeEach(() => resetJwksCache());
  afterEach(() => vi.restoreAllMocks());

  it('a browser identity JWT authenticates /agents as human with the email as actor', async () => {
    const t = await accessTokens();
    serveAccessCerts([t.jwk]);
    const worldId = worldName('human');
    const read = await SELF.fetch(`https://world-edge.test/agents/world-agent/${worldId}`, { headers: { 'cf-access-jwt-assertion': t.identityJwt } });
    expect(read.status).toBe(200);

    const write = await SELF.fetch(`https://world-edge.test/agents/world-agent/${worldId}/ops`, {
      method: 'POST',
      headers: { 'cf-access-jwt-assertion': t.identityJwt, 'content-type': 'application/json' },
      body: JSON.stringify({ ops: [{ op: 'addNode', node: { id: 'n_h', kind: 'note', title: 'h', position: { x: 0, y: 0 } } }] }),
    });
    expect(write.status).toBe(200);
    const log = await (await agentFor(worldId)).listOps(0, 10);
    expect(log.map((e) => ({ harness: e.harness, actor: e.actor }))).toEqual([{ harness: 'human', actor: 'frank@example.com' }]);
  });

  it('401 for an Access service-token JWT on /agents and /media', async () => {
    const t = await accessTokens();
    serveAccessCerts([t.jwk]);
    const worldId = worldName('svc');
    const headers = { 'cf-access-jwt-assertion': t.serviceJwt, 'content-type': 'application/json' };
    expect((await SELF.fetch(`https://world-edge.test/agents/world-agent/${worldId}`, { headers })).status).toBe(401);
    const write = await SELF.fetch(`https://world-edge.test/agents/world-agent/${worldId}/ops`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ops: [{ op: 'addNode', node: { id: 'n_s', kind: 'note', title: 's', position: { x: 0, y: 0 } } }] }),
    });
    expect(write.status).toBe(401);
    expect(await nodeCount(worldId)).toBe(0);
    const signed = await SELF.fetch('https://world-edge.test/media/sign', {
      method: 'POST',
      headers,
      body: JSON.stringify({ worldId, filename: 'x.png', contentType: 'image/png' }),
    });
    expect(signed.status).toBe(401);
  });

  it('still answers 5xx AUTH_UNAVAILABLE when the Access keys cannot load', async () => {
    const t = await accessTokens();
    serveAccessCerts(null);
    const response = await SELF.fetch(`https://world-edge.test/agents/world-agent/${worldName('down')}`, { headers: { 'cf-access-jwt-assertion': t.identityJwt } });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'AUTH_UNAVAILABLE' } });
  });
});
