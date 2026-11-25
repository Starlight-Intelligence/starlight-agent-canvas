import { inspect } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import {
  createWorldClient,
  HttpMcpTransport,
  MCP_PROTOCOL_VERSION,
  WorldAuthError,
  WorldClientConfigError,
  WorldToolError,
  WorldTransportError,
  type HttpMcpTransportOptions,
} from './index.js';

const URL_ = 'https://world.example.com/mcp';
const TOKEN = 'sk_live_SECRET_token_value_9f8e7d';
const CF_ID = 'cf-client-id-SECRET-1234';
const CF_SECRET = 'cf-client-secret-SECRET-5678';
const SECRETS = [TOKEN, CF_ID, CF_SECRET];

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: { jsonrpc: string; id?: number; method: string; params?: Record<string, unknown> };
}

type Reply = Response | ((sent: Sent) => Response);

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) } });

const sse = (text: string) => new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });

/** An SSE response delivered in exactly these chunks, then closed (or left open). */
function sseChunks(chunks: string[], { close = true } = {}) {
  const encoder = new TextEncoder();
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(encoder.encode(chunks[i++]!));
      else if (close) controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const initResult = (id: number, session = 'sess-1') =>
  json({ jsonrpc: '2.0', id, result: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: 'world', version: '1' } } }, { headers: { 'mcp-session-id': session } });

const accepted = () => new Response(null, { status: 202 });

const toolResult = (id: number, result: Record<string, unknown>) => json({ jsonrpc: '2.0', id, result });

/** A fake MCP server. `onTool` answers tools/call; initialize and notifications are handled. */
function fakeServer(onTool: (sent: Sent, count: number) => Response, opts: { sessions?: string[] } = {}) {
  const sent: Sent[] = [];
  const sessions = [...(opts.sessions ?? ['sess-1'])];
  let toolCalls = 0;
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    const entry: Sent = { url, headers: { ...(init.headers as Record<string, string>) }, body: JSON.parse(String(init.body)) };
    sent.push(entry);
    if (entry.body.method === 'initialize') return initResult(entry.body.id!, sessions.shift() ?? 'sess-x');
    if (entry.body.method === 'notifications/initialized') return accepted();
    toolCalls += 1;
    return onTool(entry, toolCalls);
  });
  return { fetch, sent };
}

const env = { WORLD_CANVAS_TOKEN: TOKEN, CF_ACCESS_CLIENT_ID: CF_ID, CF_ACCESS_CLIENT_SECRET: CF_SECRET };

function transport(fetch: HttpMcpTransportOptions['fetch'], overrides: Partial<HttpMcpTransportOptions> = {}) {
  return new HttpMcpTransport({
    url: URL_,
    auth: {
      tokenEnvVar: 'WORLD_CANVAS_TOKEN',
      headerEnvVars: { 'CF-Access-Client-Id': 'CF_ACCESS_CLIENT_ID', 'CF-Access-Client-Secret': 'CF_ACCESS_CLIENT_SECRET' },
    },
    env,
    fetch,
    ...overrides,
  });
}

function expectNoSecrets(error: unknown) {
  const text = [String(error), (error as Error)?.message, (error as Error)?.stack, JSON.stringify(error)].join('\n');
  for (const secret of SECRETS) expect(text).not.toContain(secret);
}

describe('HttpMcpTransport handshake', () => {
  it('initializes, sends notifications/initialized, then calls the tool with session and version headers', async () => {
    const server = fakeServer((s) => toolResult(s.body.id!, { content: [], structuredContent: { ok: 1 } }));
    const t = transport(server.fetch, { clientInfo: { name: 'test-agent', version: '9.9.9' } });
    await expect(t.callTool('get_world', { worldId: 'arcanea' })).resolves.toEqual({ ok: 1 });

    expect(server.sent.map((s) => s.body.method)).toEqual(['initialize', 'notifications/initialized', 'tools/call']);
    const [init, notified, call] = server.sent as [Sent, Sent, Sent];
    expect(init.url).toBe(URL_);
    expect(init.body.params).toEqual({ protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test-agent', version: '9.9.9' } });
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(init.headers.Accept).toBe('application/json, text/event-stream');
    expect(init.headers['Mcp-Session-Id']).toBeUndefined();
    expect(init.headers['MCP-Protocol-Version']).toBeUndefined();
    expect(notified.body.id).toBeUndefined();
    for (const later of [notified, call]) {
      expect(later.headers['Mcp-Session-Id']).toBe('sess-1');
      expect(later.headers['MCP-Protocol-Version']).toBe('2025-11-25');
    }
    expect(call.body.params).toEqual({ name: 'get_world', arguments: { worldId: 'arcanea' } });
  });

  it('initializes once for many calls', async () => {
    const server = fakeServer((s) => toolResult(s.body.id!, { structuredContent: { n: s.body.id } }));
    const t = transport(server.fetch);
    await Promise.all([t.callTool('get_world', {}), t.callTool('get_world', {}), t.callTool('get_world', {})]);
    expect(server.sent.filter((s) => s.body.method === 'initialize')).toHaveLength(1);
    expect(server.sent.filter((s) => s.body.method === 'tools/call')).toHaveLength(3);
  });

  it('takes the bearer token and extra headers from the named env vars at request time', async () => {
    const liveEnv: Record<string, string | undefined> = { ...env };
    const server = fakeServer((s) => toolResult(s.body.id!, { structuredContent: {} }));
    const t = transport(server.fetch, { env: liveEnv });
    await t.callTool('get_world', {});
    liveEnv.WORLD_CANVAS_TOKEN = 'rotated-token';
    await t.callTool('get_world', {});
    const calls = server.sent.filter((s) => s.body.method === 'tools/call');
    expect(calls[0]!.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(calls[0]!.headers['CF-Access-Client-Id']).toBe(CF_ID);
    expect(calls[0]!.headers['CF-Access-Client-Secret']).toBe(CF_SECRET);
    expect(calls[1]!.headers.Authorization).toBe('Bearer rotated-token');
    for (const s of server.sent) expect(s.headers.Authorization).toMatch(/^Bearer /);
  });

  it('reads globalThis.process.env when no env is passed', async () => {
    vi.stubEnv('WORLD_CANVAS_TOKEN_FROM_PROCESS', 'process-token');
    try {
      const server = fakeServer((s) => toolResult(s.body.id!, { structuredContent: {} }));
      const t = new HttpMcpTransport({ url: URL_, auth: { tokenEnvVar: 'WORLD_CANVAS_TOKEN_FROM_PROCESS' }, fetch: server.fetch });
      await t.callTool('get_world', {});
      expect(server.sent[0]!.headers.Authorization).toBe('Bearer process-token');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('HttpMcpTransport responses', () => {
  it('parses an SSE response and picks the matching id', async () => {
    const server = fakeServer((s) => sse([
      ': keep-alive',
      'event: message',
      `data: {"jsonrpc":"2.0","method":"notifications/progress","params":{"progress":1}}`,
      '',
      'event: message',
      `data: {"jsonrpc":"2.0","id":999,"result":{"structuredContent":{"wrong":true}}}`,
      '',
      'event: message',
      `data: {"jsonrpc":"2.0","id":${s.body.id},`,
      `data: "result":{"content":[{"type":"text","text":"{\\"worldVersion\\":4}"}]}}`,
      '',
      '',
    ].join('\r\n')));
    await expect(transport(server.fetch).callTool('search', {})).resolves.toEqual({ worldVersion: 4 });
  });

  it('parses SSE delivered in small chunks and stops reading after the match', async () => {
    let pulls = 0;
    const server = fakeServer((s) => {
      const text = `data: {"jsonrpc":"2.0","id":${s.body.id},"result":{"structuredContent":{"chunked":true}}}\r\n\r\n`;
      const encoder = new TextEncoder();
      let offset = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls += 1;
          // Never close: a real server may keep the stream open.
          if (offset < text.length) {
            controller.enqueue(encoder.encode(text.slice(offset, offset + 7)));
            offset += 7;
          }
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
    });
    await expect(transport(server.fetch).callTool('search', {})).resolves.toEqual({ chunked: true });
    expect(pulls).toBeGreaterThan(5);
  });

  it('prefers structuredContent over text content', async () => {
    const server = fakeServer((s) => toolResult(s.body.id!, {
      content: [{ type: 'text', text: '{"from":"text"}' }],
      structuredContent: { from: 'structured' },
    }));
    await expect(transport(server.fetch).callTool('search', {})).resolves.toEqual({ from: 'structured' });
  });

  it('falls back to the first text item', async () => {
    const server = fakeServer((s) => toolResult(s.body.id!, {
      content: [{ type: 'image', data: 'xx', mimeType: 'image/png' }, { type: 'text', text: '{"from":"text"}' }],
    }));
    await expect(transport(server.fetch).callTool('search', {})).resolves.toEqual({ from: 'text' });
  });

  it('rejects a result with neither structured nor JSON text content', async () => {
    const server = fakeServer((s) => toolResult(s.body.id!, { content: [{ type: 'text', text: 'not json' }] }));
    await expect(transport(server.fetch).callTool('search', {})).rejects.toBeInstanceOf(WorldTransportError);
  });

  it('maps isError with an op error to a WorldToolError with STALE_VERSION details', async () => {
    const server = fakeServer((s) => toolResult(s.body.id!, {
      isError: true,
      content: [{
        type: 'text',
        text: JSON.stringify({ error: { code: 'STALE_VERSION', message: 'node n_a is at version 3, op was based on 2.', opIndex: 0, id: 'n_a', expectedVersion: 2, actualVersion: 3 } }),
      }],
    }));
    const error = await transport(server.fetch).callTool('update_node', {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WorldToolError);
    const toolError = error as WorldToolError;
    expect(toolError.tool).toBe('update_node');
    expect(toolError.code).toBe('STALE_VERSION');
    expect(toolError.isStale).toBe(true);
    expect(toolError.opIndex).toBe(0);
    expect(toolError.id).toBe('n_a');
    expect(toolError.expectedVersion).toBe(2);
    expect(toolError.actualVersion).toBe(3);
  });

  it('maps isError with flat structuredContent', async () => {
    const server = fakeServer((s) => toolResult(s.body.id!, {
      isError: true,
      content: [],
      structuredContent: { code: 'CANON_FORBIDDEN', message: 'no' },
    }));
    const error = await transport(server.fetch).callTool('add_node', {}).catch((e: unknown) => e) as WorldToolError;
    expect(error).toBeInstanceOf(WorldToolError);
    expect(error.code).toBe('CANON_FORBIDDEN');
    expect(error.isStale).toBe(false);
  });

  it('maps isError with plain text to TOOL_ERROR', async () => {
    const server = fakeServer((s) => toolResult(s.body.id!, { isError: true, content: [{ type: 'text', text: 'Region r_x not found' }] }));
    const error = await transport(server.fetch).callTool('layout_region', {}).catch((e: unknown) => e) as WorldToolError;
    expect(error).toBeInstanceOf(WorldToolError);
    expect(error.code).toBe('TOOL_ERROR');
    expect(error.message).toContain('Region r_x not found');
  });

  it('maps a JSON-RPC error to a WorldToolError', async () => {
    const server = fakeServer((s) => json({ jsonrpc: '2.0', id: s.body.id, error: { code: -32602, message: 'Invalid params' } }));
    const error = await transport(server.fetch).callTool('search', {}).catch((e: unknown) => e) as WorldToolError;
    expect(error).toBeInstanceOf(WorldToolError);
    expect(error.code).toBe('RPC_ERROR');
    expect(error.rpcCode).toBe(-32602);
  });

  it('uses an op error carried in JSON-RPC error data', async () => {
    const server = fakeServer((s) => json({
      jsonrpc: '2.0',
      id: s.body.id,
      error: { code: -32000, message: 'stale', data: { code: 'STALE_VERSION', message: 'stale', id: 'n_a', expectedVersion: 1, actualVersion: 2 } },
    }));
    const error = await transport(server.fetch).callTool('move', {}).catch((e: unknown) => e) as WorldToolError;
    expect(error.isStale).toBe(true);
    expect(error.actualVersion).toBe(2);
  });
});

describe('HttpMcpTransport HTTP status handling', () => {
  it.each([401, 403])('maps HTTP %i to WorldAuthError', async (status) => {
    const fetch = vi.fn(async () => new Response(`denied for Bearer ${TOKEN}`, { status }));
    const error = await transport(fetch).callTool('get_world', {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WorldAuthError);
    expect((error as WorldAuthError).status).toBe(status);
    expect((error as Error).message).toContain('WORLD_CANVAS_TOKEN');
    expectNoSecrets(error);
  });

  it('re-initializes once on 404 with a session, then retries the call', async () => {
    const server = fakeServer((s, count) => (count === 1
      ? new Response('session gone', { status: 404 })
      : toolResult(s.body.id!, { structuredContent: { retried: true } })), { sessions: ['sess-1', 'sess-2'] });
    await expect(transport(server.fetch).callTool('get_world', {})).resolves.toEqual({ retried: true });
    expect(server.sent.map((s) => s.body.method)).toEqual([
      'initialize', 'notifications/initialized', 'tools/call',
      'initialize', 'notifications/initialized', 'tools/call',
    ]);
    expect(server.sent[3]!.headers['Mcp-Session-Id']).toBeUndefined();
    expect(server.sent[5]!.headers['Mcp-Session-Id']).toBe('sess-2');
  });

  it('gives up after one re-initialization', async () => {
    const server = fakeServer(() => new Response('session gone', { status: 404 }), { sessions: ['sess-1', 'sess-2', 'sess-3'] });
    const error = await transport(server.fetch).callTool('get_world', {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WorldTransportError);
    expect(server.sent.filter((s) => s.body.method === 'initialize')).toHaveLength(2);
    expect(server.sent.filter((s) => s.body.method === 'tools/call')).toHaveLength(2);
  });

  it('does not retry a 404 when no session was held', async () => {
    const fetch = vi.fn(async () => new Response('not here', { status: 404 }));
    await expect(transport(fetch).callTool('get_world', {})).rejects.toBeInstanceOf(WorldTransportError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('works with a server that issues no session id', async () => {
    const sent: Sent[] = [];
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      const entry: Sent = { url, headers: { ...(init.headers as Record<string, string>) }, body: JSON.parse(String(init.body)) };
      sent.push(entry);
      if (entry.body.method === 'initialize') {
        return json({ jsonrpc: '2.0', id: entry.body.id, result: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {} } });
      }
      if (entry.body.method === 'notifications/initialized') return accepted();
      return toolResult(entry.body.id!, { structuredContent: { ok: true } });
    });
    await expect(transport(fetch).callTool('get_world', {})).resolves.toEqual({ ok: true });
    expect(sent[2]!.headers['Mcp-Session-Id']).toBeUndefined();
  });
});

describe('HttpMcpTransport secrets', () => {
  it('fails with zero fetch calls when the token env var is missing or empty', async () => {
    for (const badEnv of [{}, { WORLD_CANVAS_TOKEN: '' }, { WORLD_CANVAS_TOKEN: '   ' }]) {
      const fetch = vi.fn();
      const t = new HttpMcpTransport({ url: URL_, auth: { tokenEnvVar: 'WORLD_CANVAS_TOKEN' }, env: badEnv, fetch });
      const error = await t.callTool('get_world', {}).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(WorldClientConfigError);
      expect((error as Error).message).toContain('WORLD_CANVAS_TOKEN');
      expect(fetch).not.toHaveBeenCalled();
    }
  });

  it('fails with zero fetch calls when a header env var is missing', async () => {
    const fetch = vi.fn();
    const t = transport(fetch, { env: { WORLD_CANVAS_TOKEN: TOKEN, CF_ACCESS_CLIENT_ID: CF_ID } });
    const error = await t.callTool('get_world', {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WorldClientConfigError);
    expect((error as Error).message).toContain('CF_ACCESS_CLIENT_SECRET');
    expect(fetch).not.toHaveBeenCalled();
    expectNoSecrets(error);
  });

  it('fails with zero fetch calls through the client too', async () => {
    const fetch = vi.fn();
    const client = createWorldClient({
      transport: new HttpMcpTransport({ url: URL_, auth: { tokenEnvVar: 'WORLD_CANVAS_TOKEN' }, env: {}, fetch }),
      worldId: 'arcanea',
    });
    await expect(client.getWorld({})).rejects.toBeInstanceOf(WorldClientConfigError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects invalid env var names without echoing them', () => {
    for (const name of [TOKEN, 'world_canvas_token', '1TOKEN', 'WORLD-TOKEN', '', 'Bearer abc']) {
      const error = (() => {
        try {
          new HttpMcpTransport({ url: URL_, auth: { tokenEnvVar: name }, env, fetch: vi.fn() });
        } catch (e) {
          return e;
        }
        return undefined;
      })();
      expect(error).toBeInstanceOf(WorldClientConfigError);
      expect((error as Error).message).toContain('^[A-Z_][A-Z0-9_]*$');
      if (name) expect((error as Error).message).not.toContain(name);
    }
    expect(() => new HttpMcpTransport({
      url: URL_, auth: { tokenEnvVar: 'WORLD_CANVAS_TOKEN', headerEnvVars: { 'CF-Access-Client-Secret': CF_SECRET } }, env,
    })).toThrow(WorldClientConfigError);
    try {
      new HttpMcpTransport({ url: URL_, auth: { tokenEnvVar: 'WORLD_CANVAS_TOKEN', headerEnvVars: { 'CF-Access-Client-Secret': CF_SECRET } }, env });
    } catch (e) {
      expectNoSecrets(e);
    }
  });

  it('has no option that accepts a token value', () => {
    const attempts: Record<string, unknown>[] = [
      { url: URL_, auth: { tokenEnvVar: 'WORLD_CANVAS_TOKEN' }, token: TOKEN },
      { url: URL_, auth: { tokenEnvVar: 'WORLD_CANVAS_TOKEN', token: TOKEN } },
      { url: URL_, auth: { tokenEnvVar: 'WORLD_CANVAS_TOKEN' }, headers: { Authorization: `Bearer ${TOKEN}` } },
      { url: URL_, auth: { tokenEnvVar: 'WORLD_CANVAS_TOKEN', headerEnvVars: { Authorization: 'WORLD_CANVAS_TOKEN' } } },
      { url: `https://user:${TOKEN}@world.example.com/mcp`, auth: { tokenEnvVar: 'WORLD_CANVAS_TOKEN' } },
      { url: URL_ },
    ];
    for (const options of attempts) {
      let caught: unknown;
      try {
        new HttpMcpTransport(options as unknown as HttpMcpTransportOptions);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(WorldClientConfigError);
      expectNoSecrets(caught);
    }
  });

  it('refuses plain http except for localhost', () => {
    expect(() => new HttpMcpTransport({ url: 'http://world.example.com/mcp', auth: { tokenEnvVar: 'T' }, env })).toThrow(WorldClientConfigError);
    expect(() => new HttpMcpTransport({ url: 'http://localhost:8787/mcp', auth: { tokenEnvVar: 'T' }, env })).not.toThrow();
  });

  it('never puts a secret in any error message, even when the server or network echoes it', async () => {
    const echo = `Authorization: Bearer ${TOKEN}; CF-Access-Client-Id: ${CF_ID}; CF-Access-Client-Secret: ${CF_SECRET}`;
    const scenarios: Array<{ name: string; reply: (sent: Sent, count: number) => Response }> = [
      { name: 'HTTP 500 body', reply: () => new Response(echo, { status: 500 }) },
      { name: 'HTTP 400 body', reply: () => new Response(echo, { status: 400 }) },
      { name: 'isError text', reply: (s) => toolResult(s.body.id!, { isError: true, content: [{ type: 'text', text: echo }] }) },
      { name: 'isError op error', reply: (s) => toolResult(s.body.id!, { isError: true, structuredContent: { code: 'INVALID_OP', message: echo, id: TOKEN } }) },
      { name: 'JSON-RPC error', reply: (s) => json({ jsonrpc: '2.0', id: s.body.id, error: { code: -32000, message: echo } }) },
      { name: 'JSON-RPC error data', reply: (s) => json({ jsonrpc: '2.0', id: s.body.id, error: { code: -32000, message: 'x', data: { code: `X_${TOKEN}`, message: echo } } }) },
      { name: 'content type', reply: () => new Response('x', { status: 200, headers: { 'content-type': `text/plain; ${TOKEN}` } }) },
      { name: '401', reply: () => new Response(echo, { status: 401 }) },
    ];
    for (const scenario of scenarios) {
      const server = fakeServer(scenario.reply);
      const error = await transport(server.fetch).callTool('get_world', {}).catch((e: unknown) => e);
      expect(error, scenario.name).toBeInstanceOf(Error);
      expectNoSecrets(error);
    }

    const throwingFetch = vi.fn(async () => {
      throw new TypeError(`fetch failed: ${echo}`);
    });
    const networkError = await transport(throwingFetch).callTool('get_world', {}).catch((e: unknown) => e);
    expect(networkError).toBeInstanceOf(WorldTransportError);
    expect((networkError as Error).cause).toBeUndefined();
    expectNoSecrets(networkError);

    const initError = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      return json({ jsonrpc: '2.0', id: body.id, error: { code: -32600, message: echo } });
    });
    const initFailure = await transport(initError).callTool('get_world', {}).catch((e: unknown) => e);
    expect(initFailure).toBeInstanceOf(WorldTransportError);
    expectNoSecrets(initFailure);
  });

  it('never logs', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => undefined));
    try {
      const server = fakeServer(() => new Response(TOKEN, { status: 500 }));
      await transport(server.fetch).callTool('get_world', {}).catch(() => undefined);
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});

describe('HttpMcpTransport review fixes', () => {
  it('keeps env and fetch out of JSON.stringify, String and util.inspect', async () => {
    const server = fakeServer((s) => toolResult(s.body.id!, { structuredContent: {} }));
    const t = transport(server.fetch);
    await t.callTool('get_world', {});
    const views = [JSON.stringify(t), String(t), inspect(t, { depth: 5, showHidden: true })];
    for (const view of views) {
      for (const secret of SECRETS) expect(view).not.toContain(secret);
      expect(view).not.toContain('sess-1');
    }
    expect(JSON.parse(views[0]!)).toEqual({
      url: URL_,
      tokenEnvVar: 'WORLD_CANVAS_TOKEN',
      headerNames: ['CF-Access-Client-Id', 'CF-Access-Client-Secret'],
    });
  });

  it('does not follow redirects and does not show the Location', async () => {
    const location = `https://evil.example/steal?t=${TOKEN}`;
    for (const status of [301, 302, 303, 307, 308]) {
      // The body echoes the Location, as many servers do.
      const fetch = vi.fn(async (_url: string, _init: RequestInit) => new Response(`Redirecting to ${location}`, { status, headers: { location } }));
      const error = await transport(fetch).callTool('get_world', {}).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(WorldTransportError);
      expect((error as WorldTransportError).status).toBe(status);
      expect((error as Error).message).toContain('Redirects are not followed');
      expect((error as Error).message).not.toContain('evil.example');
      expectNoSecrets(error);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch.mock.calls[0]![1].redirect).toBe('manual');
    }
  });

  it('treats an opaque redirect or status 0 response as an error', async () => {
    const opaque = { type: 'opaqueredirect', status: 0, ok: false, headers: new Headers(), body: null } as unknown as Response;
    for (const reply of [opaque, Response.error()]) {
      const fetch = vi.fn(async () => reply);
      const error = await transport(fetch).callTool('get_world', {}).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(WorldTransportError);
      expect((error as WorldTransportError).status).toBe(0);
      expect((error as Error).message).toContain('Redirects are not followed');
    }
  });

  it('times out a request whose fetch never resolves, and recovers on the next call', async () => {
    let hang = true;
    const server = fakeServer((s) => toolResult(s.body.id!, { structuredContent: { ok: true } }));
    const fetch = vi.fn((url: string, init: RequestInit) => (hang ? new Promise<Response>(() => undefined) : server.fetch(url, init)));
    const t = transport(fetch, { timeoutMs: 20 });
    const error = await t.callTool('get_world', {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WorldTransportError);
    expect((error as Error).message).toContain('initialize timed out after 20 ms');
    hang = false;
    await expect(t.callTool('get_world', {})).resolves.toEqual({ ok: true });
    expect(server.sent.map((s) => s.body.method)).toEqual(['initialize', 'notifications/initialized', 'tools/call']);
  });

  it('times out an SSE body that never delivers the response', async () => {
    const server = fakeServer(() => sseChunks([': waiting\n\n'], { close: false }));
    const error = await transport(server.fetch, { timeoutMs: 30 }).callTool('get_world', {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WorldTransportError);
    expect((error as Error).message).toContain('tools/call timed out');
  });

  it('validates timeoutMs', () => {
    for (const timeoutMs of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => transport(vi.fn(), { timeoutMs })).toThrow(WorldClientConfigError);
    }
    expect(() => transport(vi.fn(), { timeoutMs: 1 })).not.toThrow();
  });

  it('rejects URLs with a query string or fragment', () => {
    for (const url of [`${URL_}?token=${TOKEN}`, `${URL_}#${TOKEN}`, `${URL_}?`]) {
      let caught: unknown;
      try {
        new HttpMcpTransport({ url, auth: { tokenEnvVar: 'WORLD_CANVAS_TOKEN' }, env });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(WorldClientConfigError);
      expectNoSecrets(caught);
    }
  });

  it('only calls the ten world tools', async () => {
    const fetch = vi.fn();
    const t = transport(fetch);
    for (const name of ['remove_node', 'promote_to_canon', 'tools/list', '']) {
      await expect(t.callTool(name as never, {})).rejects.toBeInstanceOf(WorldClientConfigError);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['STALE_VERSION: node n_x is at 4', 'STALE_VERSION', 'node n_x is at 4'],
    ['CANON_LOCKED: node n_x is canon', 'CANON_LOCKED', 'node n_x is canon'],
    ['UNAUTHORIZED: token lacks write scope', 'UNAUTHORIZED', 'token lacks write scope'],
    ['NOT_A_CODE: whatever', 'TOOL_ERROR', 'NOT_A_CODE: whatever'],
    ['stale_version: lower case', 'TOOL_ERROR', 'stale_version: lower case'],
    ['STALE_VERSION without colon', 'TOOL_ERROR', 'STALE_VERSION without colon'],
  ])('maps text error %j to code %s', async (text, code, message) => {
    const server = fakeServer((s) => toolResult(s.body.id!, { isError: true, content: [{ type: 'text', text }] }));
    const error = await transport(server.fetch).callTool('update_node', {}).catch((e: unknown) => e) as WorldToolError;
    expect(error).toBeInstanceOf(WorldToolError);
    expect(error.code).toBe(code);
    expect(error.message).toBe(`update_node failed with ${code}: ${message}`);
  });

  it('sends the protocol version the server negotiated', async () => {
    const sent: Sent[] = [];
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      const entry: Sent = { url, headers: { ...(init.headers as Record<string, string>) }, body: JSON.parse(String(init.body)) };
      sent.push(entry);
      if (entry.body.method === 'initialize') {
        return json({ jsonrpc: '2.0', id: entry.body.id, result: { protocolVersion: '2025-06-18', capabilities: {} } }, { headers: { 'mcp-session-id': 's' } });
      }
      if (entry.body.method === 'notifications/initialized') return accepted();
      return toolResult(entry.body.id!, { structuredContent: {} });
    });
    await transport(fetch).callTool('get_world', {});
    expect((sent[0]!.body.params as { protocolVersion: string }).protocolVersion).toBe('2025-11-25');
    expect(sent[1]!.headers['MCP-Protocol-Version']).toBe('2025-06-18');
    expect(sent[2]!.headers['MCP-Protocol-Version']).toBe('2025-06-18');
  });

  it('parses CRLF split across chunks inside a multi-line data event', async () => {
    const server = fakeServer((s) => sseChunks([
      'event: message\r\ndata: {"jsonrpc":"2.0",\r',
      `\ndata: "id":${s.body.id},\r`,
      '\ndata: "result":{"structuredContent":{"split":true}}}\r',
      '\n\r',
      '\n',
    ], { close: false }));
    await expect(transport(server.fetch).callTool('search', {})).resolves.toEqual({ split: true });
  });

  it('dispatches a final SSE event with no trailing blank line', async () => {
    const server = fakeServer((s) => sseChunks([
      `data: {"jsonrpc":"2.0","id":${s.body.id},`,
      '"result":{"structuredContent":{"last":true}}}',
    ]));
    await expect(transport(server.fetch).callTool('search', {})).resolves.toEqual({ last: true });
  });

  it('works with globalThis.process deleted when env is passed', async () => {
    const saved = globalThis.process;
    const server = fakeServer((s) => toolResult(s.body.id!, { structuredContent: { ok: true } }));
    Reflect.deleteProperty(globalThis, 'process');
    try {
      expect((globalThis as { process?: unknown }).process).toBeUndefined();
      const withEnv = new HttpMcpTransport({ url: URL_, auth: { tokenEnvVar: 'WORLD_CANVAS_TOKEN' }, env, fetch: server.fetch });
      const result = await withEnv.callTool('get_world', {});
      const noEnvFetch = vi.fn();
      const withoutEnv = new HttpMcpTransport({ url: URL_, auth: { tokenEnvVar: 'WORLD_CANVAS_TOKEN' }, fetch: noEnvFetch });
      const error = await withoutEnv.callTool('get_world', {}).catch((e: unknown) => e);
      globalThis.process = saved;
      expect(result).toEqual({ ok: true });
      expect(server.sent[2]!.headers.Authorization).toBe(`Bearer ${TOKEN}`);
      expect(error).toBeInstanceOf(WorldClientConfigError);
      expect(noEnvFetch).not.toHaveBeenCalled();
    } finally {
      globalThis.process = saved;
    }
  });
});
