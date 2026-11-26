import { SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { authenticate, resetJwksCache, verifyAccessJwt, verifyServiceToken, type JwksFetcher } from '../src/auth.js';
import type { Env } from '../src/env.js';
import { bearer, testEnv, worldName } from './helpers.js';

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
    await expect(verifyAccessJwt(token, accessEnv, { fetcher })).resolves.toEqual({ harness: 'human', actor: 'frank@example.com', via: 'access', expiresAt: (now + 600) * 1000 });
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
    await expect(verifyServiceToken(testEnv.TEST_TOKENS.claude, testEnv)).resolves.toEqual({ harness: 'claude', actor: 'claude-test', via: 'service-token', tokenSha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
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
