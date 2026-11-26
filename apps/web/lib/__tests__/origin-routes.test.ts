import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/world/world-files', () => ({
  applyWorldOps: vi.fn(async () => ({ ok: true, graph: { world: { version: 2 } }, changed: {}, proposals: [] })),
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
