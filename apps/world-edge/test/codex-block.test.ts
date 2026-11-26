import { runInDurableObject, SELF } from 'cloudflare:test';
import { WORLD_GRAPH_SCHEMA_VERSION, type WorldNode } from '@starlight-agent-canvas/world';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetJwksCache, sha256Hex, verifyAccessJwt, type JwksFetcher, PRINCIPAL_HEADER } from '../src/auth.js';
import type { Env } from '../src/env.js';
import * as indexing from '../src/indexing.js';
import { searchWorld } from '../src/mcp.js';
import type { WorldAgent } from '../src/world-agent.js';
import { agentFor, bearer, claude, codex, nodeOp, testEnv, worldName } from './helpers.js';

// --------------------------------------------------------------- helpers --

function b64url(bytes: Uint8Array | string): string {
  const raw = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
  let s = '';
  for (const b of raw) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function keypair(kid: string) {
  const pair = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey;
  return { pair, jwk: { ...jwk, kid } };
}

async function sign(privateKey: CryptoKey, payload: Record<string, unknown>, kid: string) {
  const head = b64url(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(new Uint8Array(sig))}`;
}

function collect(ws: WebSocket) {
  const messages: Record<string, unknown>[] = [];
  const closes: number[] = [];
  ws.addEventListener('message', (event) => {
    if (typeof event.data === 'string') messages.push(JSON.parse(event.data) as Record<string, unknown>);
  });
  ws.addEventListener('close', (event) => closes.push(event.code));
  return { messages, closes };
}

async function waitFor<T>(fn: () => T | undefined, ms = 3000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = fn();
    if (value !== undefined) return value;
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Open a socket straight to the Durable Object with a chosen principal, as the Worker would after auth. */
async function socketAs(worldId: string, principal: Record<string, unknown>) {
  const stub = await agentFor(worldId);
  const response = await stub.fetch(new Request(`https://world-edge.test/agents/world-agent/${worldId}`, {
    headers: { upgrade: 'websocket', [PRINCIPAL_HEADER]: JSON.stringify(principal), 'x-partykit-room': worldId, 'x-partykit-namespace': 'world-agent' },
  }));
  expect(response.status).toBe(101);
  const ws = response.webSocket!;
  ws.accept();
  const io = collect(ws);
  await waitFor(() => io.messages.find((m) => m.type === 'world.hello'));
  return { ws, ...io };
}

function graphWith(worldId: string, nodes: Partial<WorldNode>[], regions: { id: string; title: string; bounds: { x: number; y: number; w: number; h: number } }[] = []) {
  return {
    schemaVersion: WORLD_GRAPH_SCHEMA_VERSION,
    world: { id: worldId, title: 'T', summary: '', version: 0, regions, updatedAt: '2026-11-25T00:00:00.000Z' },
    nodes: nodes.map((n, i) => ({
      id: `n_${i}`, worldId, kind: 'character', title: `Node ${i}`, summary: '', body: '', tags: [], canon: { status: 'draft' }, media: [],
      position: { x: 0, y: 0 }, regionId: null, layer: 0,
      createdBy: { harness: 'claude', at: '2026-11-25T00:00:00.000Z' }, updatedAt: '2026-11-25T00:00:00.000Z', version: 1, meta: {},
      ...n,
    })),
    edges: [],
  };
}

// ----------------------------------------------------------------- 1 JWKS --

describe('1. JWKS cache cannot be bypassed with unknown kids', () => {
  beforeEach(() => resetJwksCache());
  const accessEnv = { ACCESS_TEAM_DOMAIN: 'https://test-team.cloudflareaccess.com', ACCESS_AUD: 'test-aud' };

  it('refetches at most once per interval for unknown kids and negative-caches them', async () => {
    const { pair, jwk } = await keypair('k1');
    let fetches = 0;
    const fetcher: JwksFetcher = async () => { fetches += 1; return { keys: [jwk] }; };
    const now = Date.now();
    const payload = { iss: accessEnv.ACCESS_TEAM_DOMAIN, aud: [accessEnv.ACCESS_AUD], email: 'a@example.com', exp: Math.floor(now / 1000) + 600 };
    for (let i = 0; i < 20; i++) {
      const token = await sign(pair.privateKey, payload, `bogus-${i % 3}`);
      await expect(verifyAccessJwt(token, accessEnv, { fetcher, now: now + i })).rejects.toThrow(/unknown key/);
    }
    // One initial load plus at most one forced refresh in the interval.
    expect(fetches).toBeLessThanOrEqual(2);
    // Valid tokens still verify from cache without new fetches.
    await expect(verifyAccessJwt(await sign(pair.privateKey, payload, 'k1'), accessEnv, { fetcher, now: now + 100 })).resolves.toMatchObject({ actor: 'a@example.com' });
    expect(fetches).toBeLessThanOrEqual(2);
  });

  it('concurrent unknown-kid requests cause at most one forced refetch, without a shared promise', async () => {
    const { pair, jwk } = await keypair('k1');
    let fetches = 0;
    const fetcher: JwksFetcher = async () => { fetches += 1; await sleep(20); return { keys: [jwk] }; };
    const now = Date.now();
    const payload = { iss: accessEnv.ACCESS_TEAM_DOMAIN, aud: [accessEnv.ACCESS_AUD], email: 'a@example.com', exp: Math.floor(now / 1000) + 600 };
    // Warm the cache.
    await verifyAccessJwt(await sign(pair.privateKey, payload, 'k1'), accessEnv, { fetcher, now });
    const tokens = await Promise.all(Array.from({ length: 20 }, (_, i) => sign(pair.privateKey, payload, `rand-${i}`)));
    // Past the interval, so exactly one forced refetch is allowed.
    const results = await Promise.allSettled(tokens.map((t) => verifyAccessJwt(t, accessEnv, { fetcher, now: now + 120_000 })));
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
    expect(fetches).toBe(2);
  });

  it('still picks up a rotated key once the refetch interval has passed', async () => {
    const k1 = await keypair('k1');
    const k2 = await keypair('k2');
    let keys = [k1.jwk];
    let fetches = 0;
    const fetcher: JwksFetcher = async () => { fetches += 1; return { keys }; };
    const now = Date.now();
    const payload = { iss: accessEnv.ACCESS_TEAM_DOMAIN, aud: [accessEnv.ACCESS_AUD], email: 'a@example.com', exp: Math.floor(now / 1000) + 3600 };
    await expect(verifyAccessJwt(await sign(k2.pair.privateKey, payload, 'k2'), accessEnv, { fetcher, now })).rejects.toThrow(/unknown key/);
    keys = [k1.jwk, k2.jwk];
    // Inside the interval: still rejected, no fetch.
    const before = fetches;
    await expect(verifyAccessJwt(await sign(k2.pair.privateKey, payload, 'k2'), accessEnv, { fetcher, now: now + 5_000 })).rejects.toThrow(/unknown key/);
    expect(fetches).toBe(before);
    // After the interval: refetched, accepted.
    await expect(verifyAccessJwt(await sign(k2.pair.privateKey, payload, 'k2'), accessEnv, { fetcher, now: now + 61_000 })).resolves.toMatchObject({ via: 'access' });
  });

  it('carries the assertion expiry on the principal', async () => {
    const { pair, jwk } = await keypair('k1');
    const exp = Math.floor(Date.now() / 1000) + 600;
    const principal = await verifyAccessJwt(
      await sign(pair.privateKey, { iss: accessEnv.ACCESS_TEAM_DOMAIN, aud: [accessEnv.ACCESS_AUD], email: 'a@example.com', exp }, 'k1'),
      accessEnv, { fetcher: async () => ({ keys: [jwk] }) },
    );
    expect(principal.expiresAt).toBe(exp * 1000);
  });
});

// --------------------------------------------------- 2 socket lifetime --

describe('2. WebSocket authorization does not outlive the credential', () => {
  it('rejects messages and closes the socket after the Access assertion expires', async () => {
    const worldId = worldName('ws-exp');
    const s = await socketAs(worldId, { harness: 'human', actor: 'a@example.com', via: 'access', expiresAt: Date.now() + 400 });
    await sleep(600);
    s.ws.send(JSON.stringify({ id: 1, type: 'ops', ops: [nodeOp('n_late')] }));
    await waitFor(() => (s.closes.length > 0 ? true : undefined));
    expect(s.closes[0]).toBe(4401);
    const agent = await agentFor(worldId);
    expect(((await agent.getNodesById(['n_late'])) as unknown[]).length).toBe(0);
  });

  it('stops pushing diffs to an expired socket', async () => {
    const worldId = worldName('ws-exp-read');
    const s = await socketAs(worldId, { harness: 'human', actor: 'a@example.com', via: 'access', expiresAt: Date.now() + 400 });
    await sleep(600);
    const agent = await agentFor(worldId);
    await agent.applyBatch([nodeOp('n_secret')], codex);
    await sleep(200);
    expect(s.messages.find((m) => m.type === 'world.diff')).toBeUndefined();
    expect(s.closes[0]).toBe(4401);
  });

  it('re-checks a service token against the current MCP_SERVICE_TOKENS on each write', async () => {
    const worldId = worldName('ws-revoked');
    const response = await SELF.fetch(`https://world-edge.test/agents/world-agent/${worldId}`, { headers: { ...bearer(testEnv.TEST_TOKENS.claude), upgrade: 'websocket' } });
    const ws = response.webSocket!;
    ws.accept();
    const s = collect(ws);
    await waitFor(() => s.messages.find((m) => m.type === 'world.hello'));
    ws.send(JSON.stringify({ id: 1, type: 'ops', ops: [nodeOp('n_before')] }));
    expect(((await waitFor(() => s.messages.find((m) => m.id === 1))) as { result: { ok: boolean } }).result.ok).toBe(true);

    // Revoke: the claude token is removed from the secret while the socket stays open.
    const stub = await agentFor(worldId);
    await runInDurableObject(stub as unknown as DurableObjectStub<WorldAgent>, async (instance: WorldAgent) => {
      const env = (instance as unknown as { env: Env }).env;
      const entries = JSON.parse(env.MCP_SERVICE_TOKENS!) as { name: string }[];
      (instance as unknown as { env: Env }).env = { ...env, MCP_SERVICE_TOKENS: JSON.stringify(entries.filter((e) => e.name !== 'claude-test')) };
    });
    ws.send(JSON.stringify({ id: 2, type: 'ops', ops: [nodeOp('n_revoked')] }));
    await waitFor(() => (s.closes.length > 0 ? true : undefined));
    expect(s.closes[0]).toBe(4401);
    expect(((await stub.getNodesById(['n_revoked'])) as unknown[]).length).toBe(0);
    expect(s.messages.find((m) => m.id === 2)).toBeUndefined();
  });

  it('refuses a socket whose service token is no longer listed', async () => {
    const worldId = worldName('ws-unlisted');
    const stub = await agentFor(worldId);
    const response = await stub.fetch(new Request(`https://world-edge.test/agents/world-agent/${worldId}`, {
      headers: {
        upgrade: 'websocket',
        [PRINCIPAL_HEADER]: JSON.stringify({ harness: 'claude', actor: 'claude-test', via: 'service-token', tokenSha256: await sha256Hex('revoked-token-0123456789abcdef') }),
        'x-partykit-room': worldId,
        'x-partykit-namespace': 'world-agent',
      },
    }));
    const ws = response.webSocket!;
    ws.accept();
    const s = collect(ws);
    await waitFor(() => (s.closes.length > 0 ? true : undefined));
    expect(s.closes[0]).toBe(4401);
    expect(s.messages.find((m) => m.type === 'world.hello')).toBeUndefined();
  });

  it('a socket opened with a current service token keeps writing', async () => {
    const worldId = worldName('ws-ok');
    const response = await SELF.fetch(`https://world-edge.test/agents/world-agent/${worldId}`, { headers: { ...bearer(testEnv.TEST_TOKENS.claude), upgrade: 'websocket' } });
    const ws = response.webSocket!;
    ws.accept();
    const io = collect(ws);
    await waitFor(() => io.messages.find((m) => m.type === 'world.hello'));
    ws.send(JSON.stringify({ id: 3, type: 'ops', ops: [nodeOp('n_ok')] }));
    const reply = (await waitFor(() => io.messages.find((m) => m.id === 3))) as { result: { ok: boolean } };
    expect(reply.result.ok).toBe(true);
    ws.close();
  });
});

// ------------------------------------------------------- 3 index retry --

describe('3. failed index updates are persisted and retried', () => {
  it('keeps a failed job, retries it, and the D1 row appears', async () => {
    const worldId = worldName('idx-retry');
    const stub = await agentFor(worldId);
    let fail = true;
    await runInDurableObject(stub as unknown as DurableObjectStub<WorldAgent>, async (instance: WorldAgent) => {
      const real = instance.indexSync;
      instance.indexSync = async (...args) => {
        if (fail) throw new Error('D1 down');
        return real(...args);
      };
    });
    await stub.applyBatch([nodeOp('n_idx', 1, 1, { title: 'Indexed later' })], claude);
    await sleep(100);
    expect(await stub.pendingIndexJobs()).toBe(1);
    const missing = await testEnv.WORLD_INDEX!.prepare('SELECT title FROM world_nodes WHERE world_id = ? AND node_id = ?').bind(worldId, 'n_idx').first();
    expect(missing).toBeNull();

    fail = false;
    await stub.retryIndexJobs();
    expect(await stub.pendingIndexJobs()).toBe(0);
    const row = await testEnv.WORLD_INDEX!.prepare('SELECT title FROM world_nodes WHERE world_id = ? AND node_id = ?').bind(worldId, 'n_idx').first();
    expect(row).toEqual({ title: 'Indexed later' });
  });

  it('semantic search falls back to text search when Vectorize returns nothing', async () => {
    const worldId = worldName('sem-empty');
    const agent = await agentFor(worldId);
    await agent.applyBatch([nodeOp('n_dragon', 0, 0, { title: 'Dragon gate' })], claude);
    const env = {
      ...testEnv,
      AI: { run: async () => ({ data: [[0.1, 0.2]] }) },
      WORLD_VECTORS: { query: async () => ({ matches: [], count: 0 }) },
    } as unknown as Env;
    const result = await searchWorld(env, worldId, 'Dragon', undefined, 10);
    expect(result.mode).not.toBe('semantic');
    expect(result.hits.map((h) => h.id)).toEqual(['n_dragon']);
  });
});

// ------------------------------------------------------- 4 LIKE limits --

describe('4. text search fits the LIKE pattern limit and survives D1 errors', () => {
  it('builds escaped patterns of at most 50 bytes', () => {
    const long = 'é'.repeat(80) + ' 100%_done ' + 'x'.repeat(200);
    const patterns = (indexing as unknown as { likePatterns: (q: string) => string[] }).likePatterns(long);
    expect(patterns.length).toBeGreaterThan(0);
    for (const p of patterns) expect(new TextEncoder().encode(p).length).toBeLessThanOrEqual(50);
    expect(patterns).toContain('%100\\%\\_done%');
  });

  it('a 500-character query does not fail in the Durable Object', async () => {
    const worldId = worldName('like-do');
    const agent = await agentFor(worldId);
    await agent.applyBatch([nodeOp('n_long', 0, 0, { title: 'Gate of the long dawn' })], claude);
    const query = `long dawn ${'z'.repeat(490)}`;
    const hits = await agent.searchLocal('long dawn', undefined, 10);
    expect(hits.map((h) => h.id)).toEqual(['n_long']);
    await expect(agent.searchLocal(query, undefined, 10)).resolves.toBeDefined();
    await expect(agent.searchLocal('a'.repeat(500), undefined, 10)).resolves.toEqual([]);
  });

  it('falls back to the Durable Object when D1 errors', async () => {
    const worldId = worldName('like-d1');
    const agent = await agentFor(worldId);
    await agent.applyBatch([nodeOp('n_fb', 0, 0, { title: 'Fallback node' })], claude);
    const env = { ...testEnv, WORLD_INDEX: { prepare: () => { throw new Error('D1_ERROR: LIKE or GLOB pattern too complex'); } } } as unknown as Env;
    const result = await searchWorld(env, worldId, 'Fallback', undefined, 10);
    expect(result.mode).toBe('do-like');
    expect(result.hits.map((h) => h.id)).toEqual(['n_fb']);
  });

  it('a long query works against D1 too', async () => {
    const worldId = worldName('like-d1-long');
    const agent = await agentFor(worldId);
    await agent.applyBatch([nodeOp('n_d1', 0, 0, { title: 'Index row' })], claude);
    await sleep(200);
    const result = await searchWorld(testEnv, worldId, `Index ${'q'.repeat(300)}`, undefined, 10);
    expect(result.mode).toBe('d1-like');
    expect(result.hits).toEqual([]);
  });
});

// ------------------------------------------------- 5 proposals listing --

describe('5. proposals are counted in SQL and listed in pages', () => {
  it('paginates with limit and cursor and counts open proposals', async () => {
    const worldId = worldName('props');
    const agent = await agentFor(worldId);
    await agent.applyBatch([nodeOp('n_p1'), nodeOp('n_p2'), nodeOp('n_p3')], claude);
    for (const id of ['n_p1', 'n_p2', 'n_p3']) {
      const [current] = (await agent.getNodesById([id])) as unknown as WorldNode[];
      const r = await agent.proposeCanon({ title: `P ${id}`, targets: [{ type: 'node', id, baseVersion: current!.version }], rationale: 'r' }, claude);
      expect(r, JSON.stringify(r)).toMatchObject({ ok: true });
    }
    const first = await agent.listProposals({ status: 'open', limit: 2 });
    expect(first.proposals.map((p) => p.nodeIds[0])).toEqual(['n_p1', 'n_p2']);
    expect(first.nextCursor).toBeTruthy();
    const second = await agent.listProposals({ status: 'open', limit: 2, cursor: first.nextCursor! });
    expect(second.proposals.map((p) => p.nodeIds[0])).toEqual(['n_p3']);
    expect(second.nextCursor).toBeNull();
    expect((await agent.getWorldInfo()).openProposals).toBe(3);

    const http = await SELF.fetch(`https://world-edge.test/agents/world-agent/${worldId}/proposals?status=open&limit=1`, { headers: bearer(testEnv.TEST_TOKENS.claude) });
    const page = (await http.json()) as { proposals: unknown[]; nextCursor: string | null };
    expect(page.proposals).toHaveLength(1);
    expect(page.nextCursor).toBeTruthy();
  });
});

// ------------------------------------------------------- 6 cluster bounds --

describe('6. cluster counts use the same bounds and oversized-node path as cards', () => {
  it('ignores nodes outside the viewport and includes oversized nodes overlapping it', async () => {
    const agent = await agentFor(worldName('cluster'));
    await agent.applyBatch([
      nodeOp('n_in', 10, 10),
      // In the padded tile left of the viewport, but outside the bounds.
      nodeOp('n_out', -1000, 10),
      // In the padded tile above the viewport, but outside the bounds.
      nodeOp('n_out2', 10, -1000),
      // Origin three tiles left; wide enough to reach into the viewport.
      nodeOp('n_wide', -3 * 2048, 10, { size: { w: 4 * 2048, h: 100 } }),
    ], claude);
    const bounds = { x: 0, y: 0, w: 100, h: 100 };
    const cards = await agent.getRegion({ bounds, level: 'card' });
    const clusters = await agent.getRegion({ bounds, level: 'cluster' });
    expect(cards.ok && clusters.ok).toBe(true);
    if (cards.ok && clusters.ok) {
      expect(cards.nodes.map((n) => n.id).sort()).toEqual(['n_in', 'n_wide']);
      expect(clusters.clusters.reduce((s, c) => s + c.count, 0)).toBe(2);
      expect(clusters.clusters.map((c) => c.tile).sort()).toEqual(['-3:0', '0:0'].sort());
    }
  });
});

// ------------------------------------------------------ 7 layout truncation --

describe('7. layout_region reports truncation', () => {
  it('returns truncated: true with a message for a region of 1001 nodes', async () => {
    const worldId = worldName('layout-big');
    const agent = await agentFor(worldId);
    const bounds = { x: 0, y: 0, w: 20_000, h: 20_000 };
    const nodes = Array.from({ length: 1001 }, (_, i) => ({ id: `n_${i}`, regionId: 'r_big', position: { x: i, y: i } }));
    expect((await agent.importGraph(graphWith(worldId, nodes, [{ id: 'r_big', title: 'Big', bounds }]), claude)).ok).toBe(true);
    const result = await agent.layoutRegion('r_big', 'grid', claude);
    expect(result.ok).toBe(true);
    expect(result).toMatchObject({ moved: 1000, total: 1001, truncated: true });
    expect((result as { message?: string }).message).toMatch(/1000 of 1001/);
  });

  it('small regions are not truncated', async () => {
    const worldId = worldName('layout-small');
    const agent = await agentFor(worldId);
    const nodes = Array.from({ length: 3 }, (_, i) => ({ id: `n_${i}`, regionId: 'r_s', position: { x: i, y: i } }));
    expect((await agent.importGraph(graphWith(worldId, nodes, [{ id: 'r_s', title: 'S', bounds: { x: 0, y: 0, w: 500, h: 500 } }]), claude)).ok).toBe(true);
    expect(await agent.layoutRegion('r_s', 'grid', claude)).toMatchObject({ ok: true, moved: 3, total: 3, truncated: false });
  });
});

// ---------------------------------------------------------- media nits --

describe('media routes', () => {
  it('returns 400 for a malformed percent-encoding and 404 outside worlds/<id>/media/', async () => {
    const h = bearer(testEnv.TEST_TOKENS.claude);
    expect((await SELF.fetch('https://world-edge.test/media/object/worlds%E0%A4%A', { headers: h })).status).toBe(400);
    expect((await SELF.fetch('https://world-edge.test/media/object/worlds/w1/secret.txt', { headers: h })).status).toBe(404);
    expect((await SELF.fetch('https://world-edge.test/media/object/worlds/w1/media/missing.png', { headers: h })).status).toBe(404);
  });

  it('accepts the upload route with a trailing slash', async () => {
    const response = await SELF.fetch('https://world-edge.test/media/upload/', { method: 'PUT', body: 'x' });
    // Reaches the upload handler (signature check), not the auth wall.
    expect(response.status).toBe(403);
  });
});

void codex;
