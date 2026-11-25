import type { WorldTransport } from './client.js';
import {
  WorldAuthError,
  WorldClientConfigError,
  WorldToolError,
  WorldTransportError,
  type WorldToolErrorDetail,
} from './errors.js';

/**
 * Minimal MCP Streamable HTTP client for the World Canvas server.
 *
 * Secrets never pass through options. The bearer token and any extra secret
 * headers are read at request time from environment variables whose names
 * are configured here, and every message this transport throws has those
 * values redacted.
 */

export const MCP_PROTOCOL_VERSION = '2025-11-25';

export const ENV_VAR_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;
const HEADER_NAME_PATTERN = /^[A-Za-z0-9-]{1,128}$/;
/** Headers the transport owns; auth.headerEnvVars may not set them. */
const RESERVED_HEADERS = new Set(['authorization', 'content-type', 'accept', 'mcp-session-id', 'mcp-protocol-version', 'host', 'cookie']);
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const MESSAGE_MAX = 500;

export type EnvSource = Readonly<Record<string, string | undefined>>;
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface HttpMcpAuthOptions {
  /** Name of the environment variable that holds the bearer token, for example WORLD_CANVAS_TOKEN. */
  tokenEnvVar: string;
  /** Extra secret headers: header name to the NAME of the environment variable holding its value. */
  headerEnvVars?: Readonly<Record<string, string>>;
}

export interface HttpMcpTransportOptions {
  /** MCP endpoint. https, or http only for localhost. No credentials in the URL. */
  url: string;
  auth: HttpMcpAuthOptions;
  /** Where env vars are read from. Defaults to globalThis.process.env when it exists. */
  env?: EnvSource;
  /** Defaults to globalThis.fetch. */
  fetch?: FetchLike;
  clientInfo?: { name: string; version: string };
}

const OPTION_KEYS = new Set(['url', 'auth', 'env', 'fetch', 'clientInfo']);
const AUTH_KEYS = new Set(['tokenEnvVar', 'headerEnvVars']);

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface RpcReply {
  message: JsonRpcResponse;
  redact: (text: string) => string;
}

interface RequestSecrets {
  headers: Record<string, string>;
  values: string[];
}

export class HttpMcpTransport implements WorldTransport {
  private readonly url: string;
  private readonly tokenEnvVar: string;
  private readonly headerEnvVars: ReadonlyArray<readonly [header: string, envVar: string]>;
  private readonly env: EnvSource | undefined;
  private readonly fetchImpl: FetchLike | undefined;
  private readonly clientInfo: { name: string; version: string };
  private nextId = 1;
  private sessionId: string | undefined;
  private protocolVersion: string | undefined;
  private initializing: Promise<void> | undefined;
  private ready = false;

  constructor(options: HttpMcpTransportOptions) {
    if (!options || typeof options !== 'object') throw new WorldClientConfigError('HttpMcpTransport needs an options object.');
    for (const key of Object.keys(options)) {
      if (!OPTION_KEYS.has(key)) {
        throw new WorldClientConfigError(`Unknown HttpMcpTransport option "${safeKey(key)}". Secrets are never passed as options; name an environment variable in auth.tokenEnvVar instead.`);
      }
    }
    this.url = checkUrl(options.url);

    const auth = options.auth;
    if (!auth || typeof auth !== 'object') {
      throw new WorldClientConfigError('HttpMcpTransport needs auth.tokenEnvVar, the name of the environment variable that holds the bearer token.');
    }
    for (const key of Object.keys(auth)) {
      if (!AUTH_KEYS.has(key)) {
        throw new WorldClientConfigError(`Unknown auth option "${safeKey(key)}". Only tokenEnvVar and headerEnvVars are supported.`);
      }
    }
    this.tokenEnvVar = checkEnvVarName(auth.tokenEnvVar, 'auth.tokenEnvVar');
    this.headerEnvVars = Object.entries(auth.headerEnvVars ?? {}).map(([header, envVar]) => {
      if (!HEADER_NAME_PATTERN.test(header)) {
        throw new WorldClientConfigError('auth.headerEnvVars has an invalid header name. Use letters, digits and dashes only.');
      }
      if (RESERVED_HEADERS.has(header.toLowerCase())) {
        throw new WorldClientConfigError(`auth.headerEnvVars may not set the ${header} header.`);
      }
      return [header, checkEnvVarName(envVar, `auth.headerEnvVars["${header}"]`)] as const;
    });

    this.env = options.env;
    this.fetchImpl = options.fetch;
    this.clientInfo = options.clientInfo ?? { name: '@starlight-agent-canvas/world-agents', version: '0.1.0' };
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const send = () => this.request('tools/call', { name, arguments: args });
    let reply: RpcReply;
    try {
      await this.ensureInitialized();
      reply = await send();
    } catch (error) {
      if (!(error instanceof SessionExpired)) throw error;
      // The server forgot our session (HTTP 404). Start a new one, once.
      await this.ensureInitialized();
      try {
        reply = await send();
      } catch (retryError) {
        if (retryError instanceof SessionExpired) {
          throw new WorldTransportError('MCP session expired again right after re-initializing.', 404);
        }
        throw retryError;
      }
    }
    return readToolResult(name, reply.message, reply.redact);
  }

  private ensureInitialized(): Promise<void> {
    if (this.ready) return Promise.resolve();
    this.initializing ??= this.initialize().finally(() => {
      this.initializing = undefined;
    });
    return this.initializing;
  }

  private async initialize(): Promise<void> {
    this.ready = false;
    this.sessionId = undefined;
    this.protocolVersion = undefined;
    const { message, redact } = await this.request('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: this.clientInfo,
    });
    if (message.error) {
      throw new WorldTransportError(`MCP initialize failed: ${redact(truncate(String(message.error.message)))}`);
    }
    const result = message.result as { protocolVersion?: unknown } | undefined;
    if (!result || typeof result.protocolVersion !== 'string') {
      throw new WorldTransportError('MCP initialize returned no protocolVersion.');
    }
    // Use the version the server negotiated for every later request.
    this.protocolVersion = result.protocolVersion;
    await this.notify('notifications/initialized');
    this.ready = true;
  }

  private async notify(method: string): Promise<void> {
    const { response } = await this.post({ jsonrpc: '2.0', method });
    if (!response.ok) {
      throw new WorldTransportError(`MCP ${method} was rejected with HTTP ${response.status}.`, response.status);
    }
    await response.body?.cancel();
  }

  private async request(method: string, params: unknown): Promise<RpcReply> {
    const id = this.nextId++;
    const sentSession = this.sessionId;
    const { response, secrets } = await this.post({ jsonrpc: '2.0', id, method, params });
    const redact = makeRedactor(secrets.values);

    if (response.status === 404 && sentSession !== undefined) {
      await response.body?.cancel();
      if (this.sessionId === sentSession) {
        this.ready = false;
        this.sessionId = undefined;
        this.protocolVersion = undefined;
      }
      throw new SessionExpired();
    }
    if (!response.ok) {
      const detail = redact(truncate(await response.text().catch(() => '')));
      throw new WorldTransportError(`MCP ${method} failed with HTTP ${response.status}${detail ? `: ${detail}` : '.'}`, response.status);
    }
    if (method === 'initialize') {
      const session = response.headers.get('mcp-session-id');
      if (session) this.sessionId = session;
    }
    return { message: await readJsonRpcResponse(response, id, method, redact), redact };
  }

  private async post(message: Record<string, unknown>): Promise<{ response: Response; secrets: RequestSecrets }> {
    const secrets = this.readSecrets();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...secrets.headers,
    };
    if (this.sessionId !== undefined) headers['Mcp-Session-Id'] = this.sessionId;
    if (this.protocolVersion !== undefined) headers['MCP-Protocol-Version'] = this.protocolVersion;

    let response: Response;
    try {
      const init: RequestInit = { method: 'POST', headers, body: JSON.stringify(message) };
      response = this.fetchImpl ? await this.fetchImpl(this.url, init) : await globalThis.fetch(this.url, init);
    } catch (error) {
      // Do not keep the original error as a cause: it is not ours to vouch for.
      const reason = error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error';
      throw new WorldTransportError(`Request to the MCP server failed (${makeRedactor(secrets.values)(truncate(reason))}).`);
    }
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel();
      throw new WorldAuthError(
        `The MCP server rejected the credentials (HTTP ${response.status}). Check the token in ${this.tokenEnvVar}`
          + `${this.headerEnvVars.length ? ` and the values of ${this.headerEnvVars.map(([, envVar]) => envVar).join(', ')}` : ''}.`,
        response.status,
      );
    }
    return { response, secrets };
  }

  /** Reads every secret for one request. Throws before any network call when one is missing. */
  private readSecrets(): RequestSecrets {
    const env = this.env ?? defaultEnv();
    if (!env) {
      throw new WorldClientConfigError(`No environment to read ${this.tokenEnvVar} from. Pass the env option (for example the Worker env binding).`);
    }
    const read = (envVar: string, purpose: string): string => {
      const value = env[envVar];
      if (typeof value !== 'string' || value.trim() === '') {
        throw new WorldClientConfigError(`Environment variable ${envVar} (${purpose}) is missing or empty.`);
      }
      return value;
    };
    const token = read(this.tokenEnvVar, 'bearer token');
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    const values = [token];
    for (const [header, envVar] of this.headerEnvVars) {
      const value = read(envVar, `${header} header`);
      headers[header] = value;
      values.push(value);
    }
    return { headers, values };
  }
}

class SessionExpired extends Error {}

function defaultEnv(): EnvSource | undefined {
  return (globalThis as { process?: { env?: EnvSource } }).process?.env;
}

function checkEnvVarName(name: unknown, field: string): string {
  if (typeof name !== 'string' || !ENV_VAR_NAME_PATTERN.test(name) || name.length > 128) {
    // Never echo the value: a pasted token is the most likely mistake here.
    throw new WorldClientConfigError(
      `${field} must be the NAME of an environment variable matching ${ENV_VAR_NAME_PATTERN.source} (for example WORLD_CANVAS_TOKEN), not a secret value. The given value is not shown.`,
    );
  }
  return name;
}

function checkUrl(url: unknown): string {
  let parsed: URL;
  try {
    parsed = new URL(String(url));
  } catch {
    throw new WorldClientConfigError('HttpMcpTransport url is not a valid URL.');
  }
  if (parsed.username || parsed.password) {
    throw new WorldClientConfigError('HttpMcpTransport url must not contain credentials. Use auth.tokenEnvVar.');
  }
  const local = LOCAL_HOSTS.has(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && local)) {
    throw new WorldClientConfigError('HttpMcpTransport url must use https (http is allowed for localhost only).');
  }
  return parsed.toString();
}

function safeKey(key: string): string {
  return /^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(key) ? key : '(not shown)';
}

function makeRedactor(secrets: readonly string[]): (text: string) => string {
  const values = secrets.filter((value) => value.length > 0).sort((a, b) => b.length - a.length);
  return (text) => values.reduce((acc, value) => acc.split(value).join('[redacted]'), text);
}

function truncate(text: string): string {
  return text.length > MESSAGE_MAX ? `${text.slice(0, MESSAGE_MAX)}...` : text;
}

async function readJsonRpcResponse(
  response: Response,
  id: number,
  method: string,
  redact: (text: string) => string,
): Promise<JsonRpcResponse> {
  const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
  let found: JsonRpcResponse | undefined;
  if (contentType.includes('text/event-stream')) {
    found = await readSseResponse(response, id);
  } else if (contentType.includes('application/json')) {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new WorldTransportError(`MCP ${method} returned invalid JSON.`, response.status);
    }
    found = (Array.isArray(body) ? body : [body]).find((message) => isResponseFor(message, id));
  } else {
    await response.body?.cancel();
    throw new WorldTransportError(`MCP ${method} returned unsupported content type "${redact(truncate(contentType))}".`, response.status);
  }
  if (!found) throw new WorldTransportError(`MCP ${method} returned no JSON-RPC response for request ${id}.`, response.status);
  return found;
}

function isResponseFor(message: unknown, id: number): message is JsonRpcResponse {
  if (!message || typeof message !== 'object') return false;
  const m = message as Record<string, unknown>;
  return m.jsonrpc === '2.0' && m.id === id && ('result' in m || 'error' in m);
}

/** Reads SSE events until one carries the JSON-RPC response for `id`, then stops reading. */
async function readSseResponse(response: Response, id: number): Promise<JsonRpcResponse | undefined> {
  const parser = new SseResponseFinder(id);
  if (!response.body) return parser.push(await response.text(), true);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      const found = parser.push(done ? decoder.decode() : decoder.decode(value, { stream: true }), done);
      if (found || done) return found;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/** Incremental SSE parser that looks for one JSON-RPC response in `data:` events. */
class SseResponseFinder {
  private buffer = '';
  private data: string[] = [];

  constructor(private readonly id: number) {}

  push(chunk: string, atEnd: boolean): JsonRpcResponse | undefined {
    let text = this.buffer + chunk;
    // A trailing CR may be the first half of CRLF; wait for the next chunk.
    let held = '';
    if (!atEnd && text.endsWith('\r')) {
      text = text.slice(0, -1);
      held = '\r';
    }
    const lines = text.split(/\r\n|\r|\n/);
    // The last piece is an incomplete line until the stream ends.
    this.buffer = atEnd ? '' : (lines.pop() ?? '') + held;
    for (const line of lines) {
      if (line === '') {
        const found = this.dispatch();
        if (found) return found;
        continue;
      }
      if (line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'data') this.data.push(value);
    }
    return atEnd ? this.dispatch() : undefined;
  }

  private dispatch(): JsonRpcResponse | undefined {
    if (this.data.length === 0) return undefined;
    const payload = this.data.join('\n');
    this.data = [];
    try {
      const message: unknown = JSON.parse(payload);
      return (Array.isArray(message) ? message : [message]).find((m) => isResponseFor(m, this.id));
    } catch {
      return undefined;
    }
  }
}

function readToolResult(tool: string, response: JsonRpcResponse, redact: (text: string) => string): unknown {
  if (response.error) {
    const data = response.error.data;
    const fromData = data && typeof data === 'object' ? toolErrorDetail(data as Record<string, unknown>, redact) : undefined;
    throw new WorldToolError(tool, fromData ?? {
      code: 'RPC_ERROR',
      message: redact(truncate(String(response.error.message ?? 'unknown error'))),
      rpcCode: typeof response.error.code === 'number' ? response.error.code : undefined,
    });
  }
  const result = response.result as { isError?: unknown; structuredContent?: unknown; content?: unknown } | undefined;
  if (!result || typeof result !== 'object') throw new WorldTransportError(`${tool} returned no result.`);

  const content = Array.isArray(result.content) ? result.content : [];
  const firstText = content.find((item): item is { type: 'text'; text: string } =>
    Boolean(item) && typeof item === 'object' && (item as { type?: unknown }).type === 'text' && typeof (item as { text?: unknown }).text === 'string');

  let payload: unknown;
  let parsed = false;
  if (result.structuredContent !== undefined && result.structuredContent !== null) {
    payload = result.structuredContent;
    parsed = true;
  } else if (firstText) {
    try {
      payload = JSON.parse(firstText.text);
      parsed = true;
    } catch {
      payload = undefined;
    }
  }

  if (result.isError === true) {
    const record = parsed && payload && typeof payload === 'object' ? payload as Record<string, unknown> : undefined;
    const nested = record?.error && typeof record.error === 'object' ? record.error as Record<string, unknown> : record;
    const detail = nested ? toolErrorDetail(nested, redact) : undefined;
    throw new WorldToolError(tool, detail ?? {
      code: 'TOOL_ERROR',
      message: redact(truncate(firstText?.text ?? 'tool reported an error without details')),
    });
  }
  if (!parsed) throw new WorldTransportError(`${tool} returned neither structuredContent nor JSON text content.`);
  return payload;
}

function toolErrorDetail(source: Record<string, unknown>, redact: (text: string) => string): WorldToolErrorDetail | undefined {
  if (typeof source.code !== 'string' || source.code === '') return undefined;
  const detail: WorldToolErrorDetail = {
    code: redact(truncate(source.code)),
    message: redact(truncate(typeof source.message === 'string' ? source.message : 'no message')),
  };
  if (Number.isInteger(source.opIndex)) detail.opIndex = source.opIndex as number;
  if (typeof source.id === 'string') detail.id = redact(truncate(source.id));
  if (Number.isInteger(source.expectedVersion)) detail.expectedVersion = source.expectedVersion as number;
  if (Number.isInteger(source.actualVersion)) detail.actualVersion = source.actualVersion as number;
  return detail;
}
