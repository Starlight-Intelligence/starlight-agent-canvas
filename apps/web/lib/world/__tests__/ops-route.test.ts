import { describe, expect, it, vi } from 'vitest';

const applyWorldOps = vi.fn(async () => ({ ok: true, graph: { world: { version: 2 }, nodes: [], edges: [] }, changed: { nodes: [], edges: [], removedNodes: [], removedEdges: [] }, proposals: [] }));
vi.mock('@/lib/world/world-files', () => ({ applyWorldOps, WorldNotFoundError: class extends Error {} }));

const ctx = { params: Promise.resolve({ worldId: 'w' }) };
const LIMIT = 256 * 1024;

/** A chunked body with no Content-Length that never ends on its own. */
function endlessBody() {
  let pulled = 0;
  let cancelled = false;
  const chunk = new TextEncoder().encode(`{"ops":[],"pad":"${'x'.repeat(16 * 1024)}`);
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled += chunk.byteLength;
      controller.enqueue(chunk);
    },
    cancel() {
      cancelled = true;
    },
  });
  return { stream, stats: () => ({ pulled, cancelled }) };
}

describe('world ops route body limit', () => {
  it('answers 413 for an oversized chunked body without Content-Length, reading at most the limit', async () => {
    const { POST } = await import('@/app/api/worlds/[worldId]/ops/route');
    const { stream, stats } = endlessBody();
    const request = new Request('http://127.0.0.1:3100/api/worlds/w/ops', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: stream,
      duplex: 'half',
    } as RequestInit);
    expect(request.headers.get('content-length')).toBeNull();
    const res = await Promise.race([
      POST(request, ctx),
      new Promise<'hung'>((r) => setTimeout(() => r('hung'), 2000)),
    ]);
    expect(res).not.toBe('hung');
    expect((res as Response).status).toBe(413);
    // Bounded: the route stopped within one chunk of the limit and cancelled the stream.
    expect(stats().pulled).toBeLessThanOrEqual(LIMIT + 64 * 1024);
    expect(stats().cancelled).toBe(true);
    expect(applyWorldOps).not.toHaveBeenCalled();
  });

  it('answers 413 from a declared Content-Length over the limit', async () => {
    const { POST } = await import('@/app/api/worlds/[worldId]/ops/route');
    const body = JSON.stringify({ ops: [], pad: 'x'.repeat(LIMIT + 1) });
    const res = await POST(new Request('http://127.0.0.1:3100/api/worlds/w/ops', { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': String(body.length) }, body }), ctx);
    expect(res.status).toBe(413);
  });

  it('still accepts a normal batch', async () => {
    const { POST } = await import('@/app/api/worlds/[worldId]/ops/route');
    const res = await POST(new Request('http://127.0.0.1:3100/api/worlds/w/ops', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ops: [] }) }), ctx);
    expect(res.status).toBe(200);
  });
});

describe('world ops route op-count limit', () => {
  it('rejects a batch over the world package opsPerBatchMax with a structured 413 before applying it', async () => {
    const { LIMITS } = await import('@starlight-agent-canvas/world');
    const { POST } = await import('@/app/api/worlds/[worldId]/ops/route');
    applyWorldOps.mockClear();
    // Small ops: the batch stays far below the 256 KB byte limit.
    const ops = Array.from({ length: LIMITS.opsPerBatchMax + 1 }, (_, i) => ({ op: 'removeNode', id: `n_${i}` }));
    const body = JSON.stringify({ ops });
    expect(body.length).toBeLessThan(LIMIT);
    const res = await POST(new Request('http://127.0.0.1:3100/api/worlds/w/ops', { method: 'POST', headers: { 'content-type': 'application/json' }, body }), ctx);
    expect(res.status).toBe(413);
    const json = (await res.json()) as { ok: boolean; error: { code: string; message: string; limit?: number; received?: number } };
    expect(json.ok).toBe(false);
    expect(json.error.code).toBe('INVALID_OP');
    expect(json.error.message).toMatch(/at most \d+ ops/);
    expect(json.error.limit).toBe(LIMITS.opsPerBatchMax);
    expect(json.error.received).toBe(LIMITS.opsPerBatchMax + 1);
    expect(applyWorldOps).not.toHaveBeenCalled();
  });

  it('accepts a batch of exactly opsPerBatchMax ops', async () => {
    const { LIMITS } = await import('@starlight-agent-canvas/world');
    const { POST } = await import('@/app/api/worlds/[worldId]/ops/route');
    applyWorldOps.mockClear();
    const ops = Array.from({ length: LIMITS.opsPerBatchMax }, (_, i) => ({ op: 'removeNode', id: `n_${i}` }));
    const res = await POST(new Request('http://127.0.0.1:3100/api/worlds/w/ops', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ops }) }), ctx);
    expect(res.status).toBe(200);
    expect(applyWorldOps).toHaveBeenCalledTimes(1);
  });
});
