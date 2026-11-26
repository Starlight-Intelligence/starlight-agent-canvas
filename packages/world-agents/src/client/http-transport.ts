import type { OpErrorCode } from '@starlight-agent-canvas/world';
import type { WorldTransport } from './client.js';
import {
  WorldAuthError,
  WorldClientConfigError,
  WorldClientError,
  WorldToolError,
  WorldTransportError,
  type WorldToolErrorDetail,
} from './errors.js';
import { WORLD_TOOL_NAMES, type WorldToolName } from './tools.js';

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
export const DEFAULT_TIMEOUT_MS = 30_000;
/** Largest delay timers accept (2^31 - 1 ms); larger values overflow and fire at once. */
export const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * Codes recognised at the start of a plain-text tool error ("STALE_VERSION: ...").
 * L1's OpErrorCode union, UNAUTHORIZED, and the L2 server's INVALID_INPUT and BOUNDS_TOO_LARGE.
 */
const TEXT_ERROR_CODES = [
  'INVALID_OP',
  'INVALID_CONTEXT',
  'NOT_FOUND',
  'DUPLICATE_ID',
  'STALE_VERSION',
  'CANON_FORBIDDEN',
  'CANON_LOCKED',
  'INVALID_REFERENCE',
  'VERSION_EXHAUSTED',
  'UNAUTHORIZED',
  'INVALID_INPUT',
  'BOUNDS_TOO_LARGE',
] as const satisfies readonly (OpErrorCode | 'UNAUTHORIZED' | 'INVALID_INPUT' | 'BOUNDS_TOO_LARGE')[];
// Fails to compile if L1 adds an op error code that is missing above.
const allOpErrorCodesListed: Exclude<OpErrorCode, (typeof TEXT_ERROR_CODES)[number]> extends never ? true : never = true;
void allOpErrorCodesListed;
const TEXT_ERROR_CODE_SET = new Set<string>(TEXT_ERROR_CODES);

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
  /** Per-request timeout in milliseconds, covering the response body too. Default 30000. */
  timeoutMs?: number;
}

const OPTION_KEYS = new Set(['url', 'auth', 'env', 'fetch', 'clientInfo', 'timeoutMs']);
const AUTH_KEYS = new Set(['tokenEnvVar', 'headerEnvVars']);

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface RpcReply {
  message: JsonRpcResponse;
  sanitize: (text: string) => string;
}

interface RequestSecrets {
  headers: Record<string, string>;
  values: string[];
}

export class HttpMcpTransport implements WorldTransport {
  private readonly url: string;
  private readonly tokenEnvVar: string;
  private readonly headerEnvVars: ReadonlyArray<readonly [header: string, envVar: string]>;
  // True private fields: JSON.stringify and util.inspect cannot reach them.
  readonly #env: EnvSource | undefined;
  readonly #fetch: FetchLike | undefined;
  #sessionId: string | undefined;
  private readonly clientInfo: { name: string; version: string };
  private readonly timeoutMs: number;
  private nextId = 1;
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

    this.#env = options.env;
    this.#fetch = options.fetch;
    this.clientInfo = options.clientInfo ?? { name: '@starlight-agent-canvas/world-agents', version: '0.1.0' };
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
      throw new WorldClientConfigError(`HttpMcpTransport timeoutMs must be a positive integer number of milliseconds, at most ${MAX_TIMEOUT_MS}.`);
    }
    this.timeoutMs = timeoutMs;
  }

  /** Only non-secret facts. */
  toJSON(): { url: string; tokenEnvVar: string; headerNames: string[] } {
    return { url: this.url, tokenEnvVar: this.tokenEnvVar, headerNames: this.headerEnvVars.map(([header]) => header) };
  }

  async callTool(name: WorldToolName, args: Record<string, unknown>): Promise<unknown> {
    if (!(WORLD_TOOL_NAMES as readonly string[]).includes(name)) {
      throw new WorldClientConfigError(`HttpMcpTransport only calls the world tools (${WORLD_TOOL_NAMES.join(', ')}); "${safeKey(String(name))}" is not one of them.`);
    }
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
    return readToolResult(name, reply.message, reply.sanitize);
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
    this.#sessionId = undefined;
    this.protocolVersion = undefined;
    const { message, sanitize } = await this.request('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: this.clientInfo,
    });
    if (message.error) {
      throw new WorldTransportError(`MCP initialize failed: ${sanitize(String(message.error.message))}`);
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
    const { response } = await this.post({ jsonrpc: '2.0', method }, AbortSignal.timeout(this.timeoutMs));
    if (!response.ok) {
      throw new WorldTransportError(`MCP ${method} was rejected with HTTP ${response.status}.`, response.status);
    }
    void response.body?.cancel().catch(() => undefined);
  }

  private async request(method: string, params: unknown): Promise<RpcReply> {
    const id = this.nextId++;
    const sentSession = this.#sessionId;
    const signal = AbortSignal.timeout(this.timeoutMs);
    const { response, secrets } = await this.post({ jsonrpc: '2.0', id, method, params }, signal);
    const sanitize = makeSanitizer(secrets.values);

    if (response.status === 404 && sentSession !== undefined) {
      void response.body?.cancel().catch(() => undefined);
      if (this.#sessionId === sentSession) {
        this.ready = false;
        this.#sessionId = undefined;
        this.protocolVersion = undefined;
      }
      throw new SessionExpired();
    }
    try {
      if (!response.ok) {
        const detail = sanitize(await untilAborted(response.text(), signal));
        throw new WorldTransportError(`MCP ${method} failed with HTTP ${response.status}${detail ? `: ${detail}` : '.'}`, response.status);
      }
      if (method === 'initialize') {
        const session = response.headers.get('mcp-session-id');
        if (session) this.#sessionId = session;
      }
      return { message: await readJsonRpcResponse(response, id, method, sanitize, signal), sanitize };
    } catch (error) {
      if (error instanceof WorldClientError) throw error;
      if (signal.aborted) throw this.timeoutError(method);
      throw new WorldTransportError(`Reading the MCP ${method} response failed (${sanitize(describe(error))}).`, response.status);
    }
  }

  private timeoutError(method: string): WorldTransportError {
    return new WorldTransportError(
      `MCP ${method} timed out after ${this.timeoutMs} ms. The call may still have completed on the server (a write may have been applied); re-read before retrying.`,
    );
  }

  private async post(message: Record<string, unknown>, signal: AbortSignal): Promise<{ response: Response; secrets: RequestSecrets }> {
    const secrets = this.readSecrets();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...secrets.headers,
    };
    if (this.#sessionId !== undefined) headers['Mcp-Session-Id'] = this.#sessionId;
    if (this.protocolVersion !== undefined) headers['MCP-Protocol-Version'] = this.protocolVersion;

    let response: Response;
    try {
      // Never follow redirects: fetch would forward the secret headers to the new location.
      const init: RequestInit = { method: 'POST', headers, body: JSON.stringify(message), redirect: 'manual', signal };
      const fetchImpl = this.#fetch;
      response = await untilAborted(fetchImpl ? fetchImpl(this.url, init) : globalThis.fetch(this.url, init), signal);
    } catch (error) {
      if (signal.aborted) throw this.timeoutError(String(message.method));
      // Do not keep the original error as a cause: it is not ours to vouch for.
      throw new WorldTransportError(`Request to the MCP server failed (${makeSanitizer(secrets.values)(describe(error))}).`);
    }
    if (response.type === 'opaqueredirect' || response.status === 0 || (response.status >= 300 && response.status < 400)) {
      void response.body?.cancel().catch(() => undefined);
      // The Location value is not shown: it may carry anything.
      throw new WorldTransportError(
        `The MCP server answered with a redirect or an opaque response (HTTP ${response.status}). Redirects are not followed; configure the final URL.`,
        response.status,
      );
    }
    if (response.status === 401 || response.status === 403) {
      void response.body?.cancel().catch(() => undefined);
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
    const env = this.#env ?? defaultEnv();
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

/** Settles like `promise`, or rejects as soon as `signal` aborts (even if `promise` ignores the signal). */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error';
}

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
  if (parsed.search || parsed.hash || /[?#]/.test(String(url))) {
    throw new WorldClientConfigError('HttpMcpTransport url must not have a query string or fragment. Use auth.tokenEnvVar for secrets.');
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

/**
 * Every server- or network-supplied text goes through this before it reaches a
 * message: redact first, then truncate. Truncating first could cut a secret so
 * that redaction no longer matches and its prefix leaks.
 */
function makeSanitizer(secrets: readonly string[]): (text: string) => string {
  const values = secrets.filter((value) => value.length > 0).sort((a, b) => b.length - a.length);
  return (text) => truncate(values.reduce((acc, value) => acc.split(value).join('[redacted]'), text));
}

function truncate(text: string): string {
  return text.length > MESSAGE_MAX ? `${text.slice(0, MESSAGE_MAX)}...` : text;
}

async function readJsonRpcResponse(
  response: Response,
  id: number,
  method: string,
  sanitize: (text: string) => string,
  signal: AbortSignal,
): Promise<JsonRpcResponse> {
  const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
  let found: JsonRpcResponse | undefined;
  if (contentType.includes('text/event-stream')) {
    found = await readSseResponse(response, id, signal);
  } else if (contentType.includes('application/json')) {
    const text = await untilAborted(response.text(), signal);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new WorldTransportError(`MCP ${method} returned invalid JSON.`, response.status);
    }
    found = (Array.isArray(body) ? body : [body]).find((message) => isResponseFor(message, id));
  } else {
    void response.body?.cancel().catch(() => undefined);
    throw new WorldTransportError(`MCP ${method} returned unsupported content type "${sanitize(contentType)}".`, response.status);
  }
  if (!found) throw new WorldTransportError(`MCP ${method} returned no JSON-RPC response for request ${id}.`, response.status);
  assertWellFormedResponse(found, method, response.status);
  return found;
}

function isResponseFor(message: unknown, id: number): message is JsonRpcResponse {
  if (!message || typeof message !== 'object') return false;
  const m = message as Record<string, unknown>;
  return m.jsonrpc === '2.0' && m.id === id && ('result' in m || 'error' in m);
}

/**
 * JSON-RPC 2.0 section 5: a response has exactly one of `result` and `error`,
 * and `error` is an object with a numeric code and a string message. Anything
 * else is a protocol error, never a success.
 */
function assertWellFormedResponse(response: JsonRpcResponse, method: string, status: number): void {
  const m = response as unknown as Record<string, unknown>;
  const hasResult = 'result' in m;
  const hasError = 'error' in m;
  if (hasResult === hasError) {
    throw new WorldTransportError(`MCP ${method} returned a JSON-RPC response with ${hasResult ? 'both result and error' : 'neither result nor error'}.`, status);
  }
  if (hasError) {
    const error = m.error as Record<string, unknown> | null;
    if (!error || typeof error !== 'object' || Array.isArray(error) || typeof error.code !== 'number' || typeof error.message !== 'string') {
      throw new WorldTransportError(`MCP ${method} returned a malformed JSON-RPC error object.`, status);
    }
  }
}

/** Reads SSE events until one carries the JSON-RPC response for `id`, then stops reading. */
async function readSseResponse(response: Response, id: number, signal: AbortSignal): Promise<JsonRpcResponse | undefined> {
  const parser = new SseResponseFinder(id);
  if (!response.body) return parser.push(await untilAborted(response.text(), signal), true);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await untilAborted(reader.read(), signal);
      const found = parser.push(done ? decoder.decode() : decoder.decode(value, { stream: true }), done);
      if (found || done) return found;
    }
  } finally {
    // Not awaited: a source whose cancel never settles must not hang the call.
    void reader.cancel().catch(() => undefined);
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

function readToolResult(tool: string, response: JsonRpcResponse, sanitize: (text: string) => string): unknown {
  if (response.error) {
    const data = response.error.data;
    const fromData = data && typeof data === 'object' ? toolErrorDetail(data as Record<string, unknown>, sanitize) : undefined;
    throw new WorldToolError(tool, fromData ?? {
      code: 'RPC_ERROR',
      message: sanitize(String(response.error.message ?? 'unknown error')),
      rpcCode: typeof response.error.code === 'number' ? response.error.code : undefined,
    });
  }
  const result = response.result as { isError?: unknown; structuredContent?: unknown; content?: unknown } | undefined;
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new WorldTransportError(`${tool} returned no result.`);
  // MCP CallToolResult.isError is an optional boolean. A string "true", 1 or
  // null is a broken server, not a success.
  if ('isError' in result && result.isError !== undefined && typeof result.isError !== 'boolean') {
    throw new WorldTransportError(`${tool} returned a non-boolean isError (${typeof result.isError}).`);
  }

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
    const detail = nested ? toolErrorDetail(nested, sanitize) : undefined;
    // L2 puts the world version next to the error: {ok: false, version, error}.
    if (detail && nested !== record && Number.isInteger(record?.version)) detail.worldVersion = record!.version as number;
    throw new WorldToolError(tool, detail ?? textErrorDetail(firstText?.text, sanitize));
  }
  if (!parsed) throw new WorldTransportError(`${tool} returned neither structuredContent nor JSON text content.`);
  return payload;
}

/** Plain-text tool error. "STALE_VERSION: node n_x is at 4" keeps its code when it is a known one. */
function textErrorDetail(text: string | undefined, sanitize: (text: string) => string): WorldToolErrorDetail {
  if (text === undefined) return { code: 'TOOL_ERROR', message: 'tool reported an error without details' };
  const match = /^([A-Z_]+):\s*([\s\S]*)$/.exec(text);
  if (match && TEXT_ERROR_CODE_SET.has(match[1]!)) {
    return { code: match[1]!, message: sanitize(match[2]!.trim() || match[1]!) };
  }
  return { code: 'TOOL_ERROR', message: sanitize(text) };
}

function toolErrorDetail(source: Record<string, unknown>, sanitize: (text: string) => string): WorldToolErrorDetail | undefined {
  if (typeof source.code !== 'string' || source.code === '') return undefined;
  const detail: WorldToolErrorDetail = {
    code: sanitize(source.code),
    message: sanitize(typeof source.message === 'string' ? source.message : 'no message'),
  };
  if (Number.isInteger(source.opIndex)) detail.opIndex = source.opIndex as number;
  if (typeof source.id === 'string') detail.id = sanitize(source.id);
  if (Number.isInteger(source.expectedVersion)) detail.expectedVersion = source.expectedVersion as number;
  if (Number.isInteger(source.actualVersion)) detail.actualVersion = source.actualVersion as number;
  return detail;
}
