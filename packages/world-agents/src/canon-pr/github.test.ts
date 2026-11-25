import { describe, expect, it } from 'vitest';
import type { WorldNode } from '@starlight-agent-canvas/world';
import { CanonPrError } from './errors.js';
import {
  BASE_SHA_PLACEHOLDER,
  DEFAULT_BRANCH_PLACEHOLDER,
  GITHUB_API_VERSION,
  openCanonPr,
  planCanonPr,
  utf8ToBase64,
} from './github.js';
import type { CanonFetchInit, ResponseLike } from './guard.js';
import { buildCanonProposal } from './proposal.js';

const TOKEN = 'fake-test-token-0123456789abcdef';
const SHA = 'a'.repeat(40);
const T0 = '2026-01-01T00:00:00.000Z';

function node(id: string, overrides: Partial<WorldNode> = {}): WorldNode {
  return {
    id,
    worldId: 'testland',
    kind: 'place',
    title: `Node ${id}`,
    summary: '',
    body: 'Lumière über the 日本 shore. 🐉',
    tags: [],
    canon: { status: 'draft' },
    media: [],
    position: { x: 0, y: 0 },
    regionId: null,
    layer: 0,
    createdBy: { harness: 'claude', at: T0 },
    updatedAt: T0,
    version: 1,
    meta: {},
    ...overrides,
  };
}

const proposal = buildCanonProposal(
  {
    worldId: 'testland',
    title: 'The Glass Orchard',
    nodeIds: ['n_orchard'],
    rationale: 'Recurring place.',
    proposer: { harness: 'codex' },
    date: '2026-03-14',
  },
  [node('n_orchard')],
);

type Step = 'get-repo' | 'get-base-ref' | 'create-branch' | 'check-file' | 'put-file' | 'open-pr';
type Reply = { status: number; json?: unknown } | ((init: CanonFetchInit) => Promise<ResponseLike>);
interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
  step: Step;
  redirect?: string;
  signal?: AbortSignal;
}

function stepOf(method: string, path: string): Step {
  if (method === 'GET' && /^\/repos\/[^/]+\/[^/]+$/.test(path)) return 'get-repo';
  if (method === 'GET' && path.includes('/git/ref/heads/')) return 'get-base-ref';
  if (method === 'POST' && path.endsWith('/git/refs')) return 'create-branch';
  if (method === 'GET' && path.includes('/contents/')) return 'check-file';
  if (method === 'PUT' && path.includes('/contents/')) return 'put-file';
  if (method === 'POST' && path.endsWith('/pulls')) return 'open-pr';
  throw new Error(`unexpected ${method} ${path}`);
}

const defaults: Record<Step, Reply> = {
  'get-repo': { status: 200, json: { default_branch: 'trunk' } },
  'get-base-ref': { status: 200, json: { ref: 'refs/heads/main', object: { sha: SHA, type: 'commit' } } },
  'create-branch': { status: 201, json: { ref: 'refs/heads/canon/the-glass-orchard' } },
  'check-file': { status: 404, json: { message: 'Not Found' } },
  'put-file': { status: 201, json: { content: { path: proposal.path } } },
  'open-pr': { status: 201, json: { number: 42, html_url: 'https://github.com/Arcanea-Labs/arcanea-ai-app/pull/42' } },
};

function github(overrides: Partial<Record<Step, Reply>> = {}) {
  const calls: Recorded[] = [];
  const fetch = async (url: string, init: CanonFetchInit): Promise<ResponseLike> => {
    const step = stepOf(init.method, new URL(url).pathname);
    calls.push({
      url,
      method: init.method,
      headers: init.headers,
      body: init.body ? JSON.parse(init.body) : null,
      step,
      redirect: init.redirect,
      signal: init.signal,
    });
    const reply = overrides[step] ?? defaults[step];
    if (typeof reply === 'function') return reply(init);
    return new Response(reply.json === undefined ? null : JSON.stringify(reply.json), { status: reply.status });
  };
  return { fetch, calls };
}

function tokenSource() {
  const source = { count: 0, getToken: async () => { source.count++; return TOKEN; } };
  return source;
}

const target = { owner: 'Arcanea-Labs', repo: 'arcanea-ai-app' };

async function caught(promise: Promise<unknown>): Promise<CanonPrError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(CanonPrError);
    return error as CanonPrError;
  }
  throw new Error('expected a CanonPrError');
}

function decodeBase64Utf8(b64: string): string {
  return new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
}

describe('planCanonPr', () => {
  it('lists the calls with a known base', () => {
    const plan = planCanonPr(proposal, { ...target, base: 'main' });
    expect(plan.map((c) => [c.method, c.path])).toEqual([
      ['GET', '/repos/Arcanea-Labs/arcanea-ai-app/git/ref/heads/main'],
      ['POST', '/repos/Arcanea-Labs/arcanea-ai-app/git/refs'],
      ['GET', '/repos/Arcanea-Labs/arcanea-ai-app/contents/.arcanea/lore/proposals/2026-03-14-the-glass-orchard.md?ref=canon%2Fthe-glass-orchard'],
      ['PUT', '/repos/Arcanea-Labs/arcanea-ai-app/contents/.arcanea/lore/proposals/2026-03-14-the-glass-orchard.md'],
      ['POST', '/repos/Arcanea-Labs/arcanea-ai-app/pulls'],
    ]);
    expect(plan[0]!.body).toBeNull();
    expect(plan[1]!.body).toEqual({ ref: 'refs/heads/canon/the-glass-orchard', sha: BASE_SHA_PLACEHOLDER });
    expect(plan[3]!.body).toEqual({ message: proposal.commitMessage, content: utf8ToBase64(proposal.markdown), branch: 'canon/the-glass-orchard' });
    expect(plan[3]!.body).not.toHaveProperty('sha');
    expect(plan[4]!.body).toEqual({ title: proposal.prTitle, head: 'canon/the-glass-orchard', base: 'main', body: proposal.prBody, draft: true });
    expect(plan.every((c) => c.purpose.length > 0)).toBe(true);
  });

  it('starts with a default branch lookup when base is omitted', () => {
    const plan = planCanonPr(proposal, target);
    expect(plan.map((c) => c.step)).toEqual(['get-repo', 'get-base-ref', 'create-branch', 'check-file', 'put-file', 'open-pr']);
    expect(plan[0]!.path).toBe('/repos/Arcanea-Labs/arcanea-ai-app');
    expect(plan[1]!.path).toBe(`/repos/Arcanea-Labs/arcanea-ai-app/git/ref/heads/${DEFAULT_BRANCH_PLACEHOLDER}`);
    expect(plan[5]!.body).toMatchObject({ base: DEFAULT_BRANCH_PLACEHOLDER, draft: true });
  });

  it('URL-encodes path segments of the base branch', () => {
    const plan = planCanonPr(proposal, { ...target, base: 'release/v1.2' });
    expect(plan[0]!.path).toBe('/repos/Arcanea-Labs/arcanea-ai-app/git/ref/heads/release/v1.2');
    const odd = planCanonPr(proposal, { ...target, base: 'a_b/c-d' });
    expect(odd[0]!.path.endsWith('/git/ref/heads/a_b/c-d')).toBe(true);
  });

  it('requires owner and repo and a plain base', () => {
    for (const bad of [
      { repo: 'r' },
      { owner: 'o' },
      { owner: '', repo: 'r' },
      { owner: 'o/x', repo: 'r' },
      { owner: 'o', repo: '..' },
      { owner: 'o', repo: 'r', base: '../main' },
      { owner: 'o', repo: 'r', base: 'main?x=1' },
      { owner: 'o', repo: 'r', base: 'canon/other' },
      { owner: 'o', repo: 'r', base: 'canon/the-glass-orchard' },
    ]) {
      let code: string | undefined;
      try {
        planCanonPr(proposal, bad as never);
      } catch (error) {
        code = (error as CanonPrError).code;
      }
      expect(code, JSON.stringify(bad)).toBe('INVALID_OPTIONS');
    }
  });
});

describe('openCanonPr', () => {
  it('runs the full sequence with an explicit base and opens a draft PR', async () => {
    const gh = github();
    const tokens = tokenSource();
    const result = await openCanonPr(proposal, { ...target, base: 'main', getToken: tokens.getToken, fetch: gh.fetch });

    expect(gh.calls.map((c) => c.step)).toEqual(['get-base-ref', 'create-branch', 'check-file', 'put-file', 'open-pr']);
    expect(gh.calls.map((c) => c.method)).toEqual(['GET', 'POST', 'GET', 'PUT', 'POST']);
    expect(gh.calls[0]!.url).toBe('https://api.github.com/repos/Arcanea-Labs/arcanea-ai-app/git/ref/heads/main');
    expect(gh.calls[1]!.body).toEqual({ ref: 'refs/heads/canon/the-glass-orchard', sha: SHA });
    expect(gh.calls[2]!.url).toBe('https://api.github.com/repos/Arcanea-Labs/arcanea-ai-app/contents/.arcanea/lore/proposals/2026-03-14-the-glass-orchard.md?ref=canon%2Fthe-glass-orchard');
    const put = gh.calls[3]!;
    expect(put.body).toEqual({ message: proposal.commitMessage, content: utf8ToBase64(proposal.markdown), branch: 'canon/the-glass-orchard' });
    expect(put.body).not.toHaveProperty('sha');
    expect(decodeBase64Utf8(put.body!.content as string)).toBe(proposal.markdown);
    expect(gh.calls[4]!.body).toEqual({ title: proposal.prTitle, head: 'canon/the-glass-orchard', base: 'main', body: proposal.prBody, draft: true });

    for (const call of gh.calls) {
      expect(call.headers).toMatchObject({
        Authorization: `Bearer ${TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': GITHUB_API_VERSION,
      });
      expect(call.headers['User-Agent']).toBeTruthy();
    }
    expect(GITHUB_API_VERSION).toBe('2022-11-28');
    expect(tokens.count).toBe(1);

    expect(result).toEqual({
      prUrl: 'https://github.com/Arcanea-Labs/arcanea-ai-app/pull/42',
      prNumber: 42,
      branch: 'canon/the-glass-orchard',
      path: proposal.path,
      calls: planCanonPr(proposal, { ...target, base: 'main' }).map((c, i) => ({
        step: c.step,
        method: c.method,
        path: c.path,
        status: [200, 201, 404, 201, 201][i],
        purpose: c.purpose,
      })),
    });
  });

  it('looks up the default branch when base is omitted', async () => {
    const gh = github();
    const result = await openCanonPr(proposal, { ...target, getToken: () => TOKEN, fetch: gh.fetch });
    expect(gh.calls.map((c) => c.step)).toEqual(['get-repo', 'get-base-ref', 'create-branch', 'check-file', 'put-file', 'open-pr']);
    expect(gh.calls[0]!.url).toBe('https://api.github.com/repos/Arcanea-Labs/arcanea-ai-app');
    expect(gh.calls[1]!.url).toBe('https://api.github.com/repos/Arcanea-Labs/arcanea-ai-app/git/ref/heads/trunk');
    expect(gh.calls[5]!.body).toMatchObject({ head: 'canon/the-glass-orchard', base: 'trunk', draft: true });
    expect(result.prNumber).toBe(42);
  });

  it('accepts https://api.github.com with or without a trailing slash', async () => {
    for (const apiBaseUrl of ['https://api.github.com', 'https://api.github.com/']) {
      const gh = github();
      await openCanonPr(proposal, { ...target, base: 'main', getToken: () => TOKEN, fetch: gh.fetch, apiBaseUrl });
      expect(gh.calls[0]!.url).toBe('https://api.github.com/repos/Arcanea-Labs/arcanea-ai-app/git/ref/heads/main');
    }
  });

  it.each([
    ['https://ghe.example.com/api/v3'],
    ['https://evil.example'],
    ['http://api.github.com'],
    ['https://api.github.com:8443'],
    ['https://user:pass@api.github.com'],
    ['https://api.github.com/api/v3'],
    ['https://api.github.com.evil.example'],
    ['https://API.GITHUB.COM'],
    [''],
  ])('refuses apiBaseUrl %j before the token or any request', async (apiBaseUrl) => {
    const gh = github();
    const tokens = tokenSource();
    expect(await caught(openCanonPr(proposal, { ...target, getToken: tokens.getToken, fetch: gh.fetch, apiBaseUrl })))
      .toMatchObject({ code: 'INVALID_OPTIONS', step: 'setup' });
    expect(tokens.count).toBe(0);
    expect(gh.calls).toHaveLength(0);
  });

  it('refuses a canon/ base, given or returned as the default branch', async () => {
    const gh = github();
    expect(await caught(openCanonPr(proposal, { ...target, base: 'canon/other', getToken: () => TOKEN, fetch: gh.fetch })))
      .toMatchObject({ code: 'INVALID_OPTIONS' });
    expect(gh.calls).toHaveLength(0);
    const stacked = github({ 'get-repo': { status: 200, json: { default_branch: 'canon/other' } } });
    expect(await caught(openCanonPr(proposal, { ...target, getToken: () => TOKEN, fetch: stacked.fetch })))
      .toMatchObject({ code: 'INVALID_RESPONSE', step: 'get-repo' });
    expect(stacked.calls.map((c) => c.step)).toEqual(['get-repo']);
  });

  it('sends every request with redirect manual and a timeout signal', async () => {
    const gh = github();
    await openCanonPr(proposal, { ...target, getToken: () => TOKEN, fetch: gh.fetch });
    expect(gh.calls).toHaveLength(6);
    for (const call of gh.calls) {
      expect(call.redirect).toBe('manual');
      expect(call.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it.each([
    ['get-repo', 301, false],
    ['get-base-ref', 302, false],
    ['check-file', 307, true],
    ['put-file', 308, true],
    ['open-pr', 303, true],
  ] as const)('treats a %s redirect (%i) as an error and does not follow it', async (step, status, afterBranch) => {
    const gh = github({ [step]: { status, json: { message: 'Moved Permanently', url: 'https://evil.example/x' } } });
    const error = await caught(openCanonPr(proposal, { ...target, getToken: () => TOKEN, fetch: gh.fetch }));
    expect(error).toMatchObject({ code: 'REDIRECT', step, status });
    expect(gh.calls.at(-1)!.step).toBe(step);
    expect(gh.calls.some((c) => c.url.includes('evil'))).toBe(false);
    expect(error.branch).toBe(afterBranch ? 'canon/the-glass-orchard' : undefined);
  });

  it('treats an opaque redirect (status 0) as an error', async () => {
    const opaque = async (): Promise<ResponseLike> => ({ status: 0, type: 'opaqueredirect', text: async () => '' });
    const gh = github({ 'get-repo': opaque });
    expect(await caught(openCanonPr(proposal, { ...target, getToken: () => TOKEN, fetch: gh.fetch })))
      .toMatchObject({ code: 'REDIRECT', step: 'get-repo', status: 0 });
    expect(gh.calls).toHaveLength(1);
  });

  it('times out a request that never answers', async () => {
    const hang = (init: CanonFetchInit) => new Promise<ResponseLike>((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(init.signal!.reason));
    });
    const gh = github({ 'put-file': hang });
    const error = await caught(openCanonPr(proposal, { ...target, getToken: () => TOKEN, fetch: gh.fetch, timeoutMs: 25 }));
    expect(error).toMatchObject({ code: 'TIMEOUT', step: 'put-file', branch: 'canon/the-glass-orchard' });
    expect(error.message).toContain('25 ms');
  });

  it.each([[0], [-1], [Number.NaN], [Number.POSITIVE_INFINITY]])('refuses timeoutMs %s', async (timeoutMs) => {
    const gh = github();
    expect(await caught(openCanonPr(proposal, { ...target, getToken: () => TOKEN, fetch: gh.fetch, timeoutMs })))
      .toMatchObject({ code: 'INVALID_OPTIONS' });
    expect(gh.calls).toHaveLength(0);
  });

  it.each([
    ['check-file', { status: 200, json: { sha: 'b'.repeat(40) } }, 'FILE_EXISTS', ['get-repo', 'get-base-ref', 'create-branch', 'check-file']],
    ['put-file', { status: 409, json: { message: 'Conflict' } }, 'HTTP_ERROR', ['get-repo', 'get-base-ref', 'create-branch', 'check-file', 'put-file']],
    ['open-pr', { status: 422, json: { message: 'Validation Failed' } }, 'HTTP_ERROR', ['get-repo', 'get-base-ref', 'create-branch', 'check-file', 'put-file', 'open-pr']],
  ] as const)('reports the leftover branch when %s fails after the branch was created', async (step, reply, code, steps) => {
    const gh = github({ [step]: reply });
    const error = await caught(openCanonPr(proposal, { ...target, getToken: () => TOKEN, fetch: gh.fetch }));
    expect(error).toMatchObject({ code, step, branch: 'canon/the-glass-orchard', path: proposal.path });
    expect(error.calls!.map((c) => c.step)).toEqual(steps);
    expect(error.message).toContain('Branch canon/the-glass-orchard was left in place');
    expect(error.message).toContain('retry with a different slug');
    expect(gh.calls.some((c) => c.method === 'DELETE')).toBe(false);
  });

  it('does not report a branch when failing before it was created', async () => {
    const gh = github({ 'get-base-ref': { status: 404, json: { message: 'Not Found' } } });
    const error = await caught(openCanonPr(proposal, { ...target, getToken: () => TOKEN, fetch: gh.fetch }));
    expect(error.branch).toBeUndefined();
    expect(error.calls).toBeUndefined();
  });

  it('accepts the PR URL with GitHub canonical casing', async () => {
    const gh = github({ 'open-pr': { status: 201, json: { number: 42, html_url: 'https://github.com/arcanea-labs/Arcanea-AI-App/pull/42' } } });
    const result = await openCanonPr(proposal, { ...target, getToken: () => TOKEN, fetch: gh.fetch });
    expect(result.prUrl).toBe('https://github.com/arcanea-labs/Arcanea-AI-App/pull/42');
  });

  it.each([
    [{ number: 42, html_url: 'https://evil.example/Arcanea-Labs/arcanea-ai-app/pull/42' }],
    [{ number: 42, html_url: 'http://github.com/Arcanea-Labs/arcanea-ai-app/pull/42' }],
    [{ number: 42, html_url: 'https://github.com/Arcanea-Labs/other-repo/pull/42' }],
    [{ number: 42, html_url: 'https://github.com/Arcanea-Labs/arcanea-ai-app/pull/43' }],
    [{ number: 42, html_url: 'https://github.com/Arcanea-Labs/arcanea-ai-app/pull/42?x=1' }],
    [{ number: 42, html_url: 'https://github.com/Arcanea-Labs/arcanea-ai-app/issues/42' }],
    [{ number: 42 }],
    [{ number: 0, html_url: 'https://github.com/Arcanea-Labs/arcanea-ai-app/pull/0' }],
    [{ number: '42', html_url: 'https://github.com/Arcanea-Labs/arcanea-ai-app/pull/42' }],
  ])('rejects an unexpected PR response %j', async (json) => {
    const gh = github({ 'open-pr': { status: 201, json } });
    expect(await caught(openCanonPr(proposal, { ...target, getToken: () => TOKEN, fetch: gh.fetch })))
      .toMatchObject({ code: 'INVALID_RESPONSE', step: 'open-pr', branch: 'canon/the-glass-orchard' });
  });

  it('stops with BRANCH_EXISTS on 422 and never reuses the branch', async () => {
    const gh = github({ 'create-branch': { status: 422, json: { message: 'Reference already exists' } } });
    const error = await caught(openCanonPr(proposal, { ...target, base: 'main', getToken: () => TOKEN, fetch: gh.fetch }));
    expect(error).toMatchObject({ code: 'BRANCH_EXISTS', step: 'create-branch', status: 422, githubMessage: 'Reference already exists' });
    expect(gh.calls.map((c) => c.step)).toEqual(['get-base-ref', 'create-branch']);
  });

  it('stops with FILE_EXISTS when the file is already there, with no PUT', async () => {
    const gh = github({ 'check-file': { status: 200, json: { sha: 'b'.repeat(40), path: proposal.path } } });
    const error = await caught(openCanonPr(proposal, { ...target, base: 'main', getToken: () => TOKEN, fetch: gh.fetch }));
    expect(error).toMatchObject({ code: 'FILE_EXISTS', step: 'check-file', status: 200 });
    expect(gh.calls.filter((c) => c.method === 'PUT')).toHaveLength(0);
    expect(gh.calls.filter((c) => c.step === 'open-pr')).toHaveLength(0);
  });

  it.each([
    ['get-repo', { status: 404, json: { message: 'Not Found' } }],
    ['get-base-ref', { status: 404, json: { message: 'Not Found' } }],
    ['create-branch', { status: 403, json: { message: 'Resource not accessible by integration' } }],
    ['check-file', { status: 500, json: { message: 'Server Error' } }],
    ['put-file', { status: 409, json: { message: 'Conflict' } }],
    ['open-pr', { status: 422, json: { message: 'Validation Failed' } }],
  ] as const)('maps a %s failure to CanonPrError with status and message', async (step, reply) => {
    const gh = github({ [step]: reply });
    const error = await caught(openCanonPr(proposal, { ...target, getToken: () => TOKEN, fetch: gh.fetch }));
    expect(error).toMatchObject({ code: 'HTTP_ERROR', step, status: reply.status, githubMessage: reply.json.message });
    expect(error.message).toContain(String(reply.status));
    expect(error.message).toContain(reply.json.message);
    expect(gh.calls.at(-1)!.step).toBe(step);
  });

  it('handles error responses with no JSON body', async () => {
    const gh = github({ 'get-base-ref': { status: 502 } });
    const error = await caught(openCanonPr(proposal, { ...target, base: 'main', getToken: () => TOKEN, fetch: gh.fetch }));
    expect(error).toMatchObject({ code: 'HTTP_ERROR', step: 'get-base-ref', status: 502, githubMessage: undefined });
  });

  it('rejects unusable success responses', async () => {
    const noSha = github({ 'get-base-ref': { status: 200, json: { object: {} } } });
    expect(await caught(openCanonPr(proposal, { ...target, base: 'main', getToken: () => TOKEN, fetch: noSha.fetch })))
      .toMatchObject({ code: 'INVALID_RESPONSE', step: 'get-base-ref' });
    const noBranch = github({ 'get-repo': { status: 200, json: { default_branch: '../x' } } });
    expect(await caught(openCanonPr(proposal, { ...target, getToken: () => TOKEN, fetch: noBranch.fetch })))
      .toMatchObject({ code: 'INVALID_RESPONSE', step: 'get-repo' });
    const noPr = github({ 'open-pr': { status: 201, json: {} } });
    expect(await caught(openCanonPr(proposal, { ...target, base: 'main', getToken: () => TOKEN, fetch: noPr.fetch })))
      .toMatchObject({ code: 'INVALID_RESPONSE', step: 'open-pr' });
  });

  it.each([[''], ['   ']])('throws EMPTY_TOKEN for %j before any request', async (empty) => {
    const gh = github();
    const error = await caught(openCanonPr(proposal, { ...target, getToken: async () => empty, fetch: gh.fetch }));
    expect(error).toMatchObject({ code: 'EMPTY_TOKEN', step: 'token' });
    expect(gh.calls).toHaveLength(0);
  });

  it('refuses tokens with whitespace and wraps getToken failures, before any request', async () => {
    const gh = github();
    expect(await caught(openCanonPr(proposal, { ...target, getToken: () => `${TOKEN}\r\nX-Evil: 1`, fetch: gh.fetch })))
      .toMatchObject({ code: 'INVALID_TOKEN' });
    const failing = await caught(openCanonPr(proposal, { ...target, getToken: () => { throw new Error(`vault said ${TOKEN}`); }, fetch: gh.fetch }));
    expect(failing).toMatchObject({ code: 'TOKEN_UNAVAILABLE', step: 'token' });
    expect(failing.message).not.toContain(TOKEN);
    expect(gh.calls).toHaveLength(0);
  });

  it('does not call getToken when the options are invalid', async () => {
    const tokens = tokenSource();
    const gh = github();
    expect(await caught(openCanonPr(proposal, { owner: '', repo: 'r', getToken: tokens.getToken, fetch: gh.fetch })))
      .toMatchObject({ code: 'INVALID_OPTIONS' });
    expect(await caught(openCanonPr(proposal, { ...target, apiBaseUrl: 'http://api.github.com', getToken: tokens.getToken, fetch: gh.fetch })))
      .toMatchObject({ code: 'INVALID_OPTIONS' });
    expect(tokens.count).toBe(0);
    expect(gh.calls).toHaveLength(0);
  });

  it('keeps the token out of results and errors, even when GitHub echoes it', async () => {
    const ok = github();
    const result = await openCanonPr(proposal, { ...target, getToken: () => TOKEN, fetch: ok.fetch });
    expect(JSON.stringify(result)).not.toContain(TOKEN);

    const echo = github({ 'put-file': { status: 401, json: { message: `Bad credentials: ${TOKEN}` } } });
    const error = await caught(openCanonPr(proposal, { ...target, getToken: () => TOKEN, fetch: echo.fetch }));
    expect(error.githubMessage).toBe('Bad credentials: [redacted]');
    for (const text of [error.message, String(error), error.stack ?? '', JSON.stringify(error), String(error.githubMessage)]) {
      expect(text).not.toContain(TOKEN);
    }

    const network = async (_url: string, init: CanonFetchInit) => {
      throw new Error(`socket closed while sending ${init.headers.Authorization}`);
    };
    const netError = await caught(openCanonPr(proposal, { ...target, getToken: () => TOKEN, fetch: network }));
    expect(netError).toMatchObject({ code: 'NETWORK_ERROR', step: 'get-repo' });
    expect(netError.message).toContain('[redacted]');
    expect(netError.message).not.toContain(TOKEN);
    expect(JSON.stringify(netError)).not.toContain(TOKEN);
    expect(netError.cause).toBeUndefined();
  });
});

describe('utf8ToBase64', () => {
  it.each([
    [''],
    ['ascii only'],
    ['Lumière über ⏳ ✅ 🔧 日本語 🐉 — “quotes”'],
    ['x'.repeat(70_000) + 'é'],
  ])('round-trips %#', (text) => {
    const b64 = utf8ToBase64(text);
    expect(b64).toMatch(/^[A-Za-z0-9+/]*={0,2}$/);
    expect(decodeBase64Utf8(b64)).toBe(text);
    expect(b64).toBe(Buffer.from(text, 'utf8').toString('base64'));
  });
});
