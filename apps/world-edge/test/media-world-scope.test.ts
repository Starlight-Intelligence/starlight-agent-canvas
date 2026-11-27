import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { bearer, testEnv, worldName } from './helpers.js';

const BASE = 'https://world-edge.test';

async function uploadTo(worldId: string, token: string): Promise<string> {
  const sign = await SELF.fetch(`${BASE}/media/sign`, {
    method: 'POST',
    headers: { ...bearer(token), 'content-type': 'application/json' },
    body: JSON.stringify({ worldId, filename: 'map.png', contentType: 'image/png' }),
  });
  expect(sign.status).toBe(200);
  const { uploadUrl, key } = (await sign.json()) as { uploadUrl: string; key: string };
  const put = await SELF.fetch(uploadUrl, { method: 'PUT', headers: { 'content-type': 'image/png', 'content-length': '4' }, body: new Uint8Array([1, 2, 3, 4]) });
  expect(put.status).toBe(200);
  return key;
}

describe('media reads are authorized for the world in the key', () => {
  it('a world-scoped token cannot read media from another world', async () => {
    const otherKey = await uploadTo(worldName('other'), testEnv.TEST_TOKENS.claude);
    const read = await SELF.fetch(`${BASE}/media/object/${otherKey}`, { headers: bearer(testEnv.TEST_TOKENS.scoped) });
    expect(read.status).toBe(403);
    expect(((await read.json()) as { error: { code: string } }).error.code).toBe('WORLD_FORBIDDEN');
  });

  it('a world-scoped token reads media from its own world; unscoped tokens read any world', async () => {
    const ownKey = await uploadTo('scoped-world', testEnv.TEST_TOKENS.scoped);
    expect((await SELF.fetch(`${BASE}/media/object/${ownKey}`, { headers: bearer(testEnv.TEST_TOKENS.scoped) })).status).toBe(200);
    expect((await SELF.fetch(`${BASE}/media/object/${ownKey}`, { headers: bearer(testEnv.TEST_TOKENS.claude) })).status).toBe(200);
  });

  it('a world-scoped token cannot sign uploads, open the world agent, or call MCP tools for another world', async () => {
    const other = worldName('other');
    const sign = await SELF.fetch(`${BASE}/media/sign`, {
      method: 'POST',
      headers: { ...bearer(testEnv.TEST_TOKENS.scoped), 'content-type': 'application/json' },
      body: JSON.stringify({ worldId: other, filename: 'x.png', contentType: 'image/png' }),
    });
    expect(sign.status).toBe(403);
    expect((await SELF.fetch(`${BASE}/agents/world-agent/${other}`, { headers: bearer(testEnv.TEST_TOKENS.scoped) })).status).toBe(403);

    const mcp = await SELF.fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: { ...bearer(testEnv.TEST_TOKENS.scoped), 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_world', arguments: { worldId: other } } }),
    });
    const text = await mcp.text();
    expect(text).toContain('WORLD_FORBIDDEN');
  });
});
