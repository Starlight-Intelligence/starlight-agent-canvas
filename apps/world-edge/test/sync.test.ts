import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { WorldDiffMessage } from '../src/world-agent.js';
import { agentFor, bearer, codex, nodeOp, testEnv, worldName } from './helpers.js';

function collect(ws: WebSocket) {
  const messages: Record<string, unknown>[] = [];
  ws.addEventListener('message', (event) => {
    if (typeof event.data === 'string') messages.push(JSON.parse(event.data) as Record<string, unknown>);
  });
  return messages;
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

describe('state sync over WebSocket', () => {
  it('broadcasts world.diff to connected clients when another harness writes', async () => {
    const worldId = worldName('sync');
    const response = await SELF.fetch(`https://world-edge.test/agents/world-agent/${worldId}`, {
      headers: { ...bearer(testEnv.TEST_TOKENS.claude), upgrade: 'websocket' },
    });
    expect(response.status).toBe(101);
    const ws = response.webSocket!;
    ws.accept();
    const messages = collect(ws);
    await waitFor(() => messages.find((m) => m.type === 'world.hello'));

    const agent = await agentFor(worldId);
    await agent.applyBatch([nodeOp('n_live', 5, 5)], codex);

    const diff = (await waitFor(() => messages.find((m) => m.type === 'world.diff'))) as unknown as WorldDiffMessage;
    expect(diff).toMatchObject({ worldId, version: 1, harness: 'codex', removedNodes: [] });
    expect(diff.nodes.map((n) => n.id)).toEqual(['n_live']);

    // The socket can write too, as its authenticated principal.
    ws.send(JSON.stringify({ id: 7, type: 'ops', ops: [{ op: 'moveNodes', moves: [{ id: 'n_live', baseVersion: 1, position: { x: 50, y: 50 } }] }] }));
    const reply = (await waitFor(() => messages.find((m) => m.type === 'result' && m.id === 7))) as { result: { ok: boolean; version: number } };
    expect(reply.result).toMatchObject({ ok: true, version: 2 });
    const log = await agent.listOps();
    expect(log.at(-1)).toMatchObject({ harness: 'claude', actor: 'claude-test' });
    ws.close();
  });

  it('refuses a WebSocket upgrade without a principal', async () => {
    const response = await SELF.fetch(`https://world-edge.test/agents/world-agent/${worldName('sync')}`, { headers: { upgrade: 'websocket' } });
    expect(response.status).toBe(401);
  });
});
