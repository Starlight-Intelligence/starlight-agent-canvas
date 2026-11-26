import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/world/world-files', () => ({
  applyWorldOps: vi.fn(async () => ({ ok: true, graph: { world: { version: 2 } }, changed: {}, proposals: [] })),
  readWorld: vi.fn(async () => {
    throw new Error("ENOENT: no such file, open '/home/secret/.starlight/world.json'");
  }),
  WorldNotFoundError: class extends Error {},
}));
vi.mock('@/lib/store', () => ({
  getStore: () => ({ createCheckpoint: vi.fn(async () => ({ id: 'c1' })), listCheckpoints: vi.fn(async () => []) }),
}));

const rebinding = { host: 'attacker.example:3000', origin: 'http://attacker.example:3000', 'content-type': 'application/json' };

function post(url: string, headers: Record<string, string>) {
  return new Request(url, { method: 'POST', headers, body: JSON.stringify({ ops: [] }) });
}

describe('state-changing routes reject DNS-rebinding origins', () => {
  it('world ops', async () => {
    const { POST } = await import('@/app/api/worlds/[worldId]/ops/route');
    const ctx = { params: Promise.resolve({ worldId: 'w' }) };
    expect((await POST(post('http://attacker.example:3000/api/worlds/w/ops', rebinding), ctx)).status).toBe(403);
    const ok = await POST(post('http://127.0.0.1:3000/api/worlds/w/ops', { origin: 'http://localhost:3000', 'content-type': 'application/json' }), ctx);
    expect(ok.status).toBe(200);
    const wrongType = await POST(post('http://127.0.0.1:3000/api/worlds/w/ops', { origin: 'http://localhost:3000', 'content-type': 'text/plain' }), ctx);
    expect(wrongType.status).toBe(415);
  });
  it('checkpoints', async () => {
    const { POST } = await import('@/app/api/canvases/[id]/checkpoints/route');
    const ctx = { params: Promise.resolve({ id: 'c' }) };
    expect((await POST(post('http://attacker.example:3000/api/canvases/c/checkpoints', rebinding), ctx)).status).toBe(403);
  });
  it('website plan changes', async () => {
    const { websiteOriginDenied } = await import('@/lib/website-response');
    const denied = websiteOriginDenied(post('http://attacker.example:3000/api/website', rebinding));
    expect(denied?.status).toBe(403);
    expect(websiteOriginDenied(post('http://127.0.0.1:3000/api/website', { origin: 'http://127.0.0.1:3000' }))).toBeNull();
  });
});

describe('world ops body limits', () => {
  const ctx = { params: Promise.resolve({ worldId: 'w' }) };
  const headers = { origin: 'http://localhost:3000', 'content-type': 'application/json' };
  const send = (body: string) => new Request('http://127.0.0.1:3000/api/worlds/w/ops', { method: 'POST', headers, body });

  it('rejects a body over 256 KB with 413', async () => {
    const { POST } = await import('@/app/api/worlds/[worldId]/ops/route');
    const res = await POST(send(JSON.stringify({ ops: [], pad: 'x'.repeat(256 * 1024 + 1) })), ctx);
    expect(res.status).toBe(413);
  });
  it('rejects more than the per-batch op cap with 413', async () => {
    const { POST } = await import('@/app/api/worlds/[worldId]/ops/route');
    const { LIMITS } = await import('@starlight-agent-canvas/world');
    const res = await POST(send(JSON.stringify({ ops: Array.from({ length: LIMITS.opsPerBatchMax + 1 }, () => ({})) })), ctx);
    expect(res.status).toBe(413);
  });
  it('still accepts a batch at the cap', async () => {
    const { POST } = await import('@/app/api/worlds/[worldId]/ops/route');
    const { LIMITS } = await import('@starlight-agent-canvas/world');
    const res = await POST(send(JSON.stringify({ ops: Array.from({ length: LIMITS.opsPerBatchMax }, () => ({})) })), ctx);
    expect(res.status).toBe(200);
  });
});

describe('world GET error responses', () => {
  it('does not leak the underlying error message on 500', async () => {
    const { GET } = await import('@/app/api/worlds/[worldId]/route');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await GET(new Request('http://127.0.0.1:3000/api/worlds/w'), { params: Promise.resolve({ worldId: 'w' }) });
    expect(res.status).toBe(500);
    const text = JSON.stringify(await res.json());
    expect(text).not.toContain('/home/secret');
    expect(text).not.toContain('ENOENT');
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
