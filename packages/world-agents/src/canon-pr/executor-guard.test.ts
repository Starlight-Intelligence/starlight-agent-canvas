import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorldNode } from '@starlight-agent-canvas/world';
import { CanonGuardError } from './errors.js';
import { openCanonPr } from './github.js';
import type { CanonFetchInit, FetchLike } from './guard.js';
import { buildCanonProposal } from './proposal.js';

/**
 * Proves openCanonPr sends every request through createCanonWriteGuard.
 * The mock keeps the real guard but lets a test rewrite a request on its way
 * in, as a bug or a tampered plan would. If openCanonPr called fetch directly,
 * the rewrite would never happen, no error would be raised, and these tests fail.
 */
const hooks = vi.hoisted(() => ({
  seen: [] as string[],
  tamper: null as null | ((url: string, init: CanonFetchInit) => [string, CanonFetchInit]),
}));

vi.mock('./guard.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./guard.js')>();
  return {
    ...actual,
    createCanonWriteGuard: (inner: FetchLike, options: { owner: string; repo: string }): FetchLike => {
      const real = actual.createCanonWriteGuard(inner, options);
      return (url, init) => {
        hooks.seen.push(`${init.method} ${url}`);
        const [nextUrl, nextInit] = hooks.tamper ? hooks.tamper(url, init) : [url, init];
        return real(nextUrl, nextInit);
      };
    },
  };
});

const T0 = '2026-01-01T00:00:00.000Z';
const SHA = 'd'.repeat(40);
const OWNER = 'Arcanea-Labs';
const REPO = 'arcanea-ai-app';

const node: WorldNode = {
  id: 'n1',
  worldId: 'testland',
  kind: 'place',
  title: 'Node n1',
  summary: '',
  body: 'Body.',
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
};

const proposal = buildCanonProposal(
  { worldId: 'testland', title: 'Proposal', nodeIds: ['n1'], rationale: 'Because.', proposer: { harness: 'claude' }, date: '2026-03-14' },
  [node],
);

function github() {
  const calls: string[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push(`${init.method} ${url}`);
    const path = new URL(url).pathname;
    if (init.method === 'GET' && path.includes('/git/ref/heads/')) return Response.json({ object: { sha: SHA } });
    if (init.method === 'GET' && path.includes('/contents/')) return new Response('{}', { status: 404 });
    if (init.method === 'GET') return Response.json({ default_branch: 'main' });
    if (path.endsWith('/pulls')) return Response.json({ number: 9, html_url: `https://github.com/${OWNER}/${REPO}/pull/9` }, { status: 201 });
    return Response.json({}, { status: 201 });
  };
  return { fetch, calls };
}

const run = (fetch: FetchLike) => openCanonPr(proposal, { owner: OWNER, repo: REPO, getToken: () => 'tok', fetch });

afterEach(() => {
  hooks.seen.length = 0;
  hooks.tamper = null;
});

describe('openCanonPr routes every request through the write guard', () => {
  it('passes each request to the guard before fetch sees it', async () => {
    const gh = github();
    await run(gh.fetch);
    expect(gh.calls).toHaveLength(6);
    expect(hooks.seen).toEqual(gh.calls);
  });

  it('refuses a PUT rewritten to CANON_LOCKED.md before fetch sees it', async () => {
    hooks.tamper = (url, init) => [
      init.method === 'PUT' ? url.replace(/contents\/.*$/, 'contents/.arcanea/lore/CANON_LOCKED.md') : url,
      init,
    ];
    const gh = github();
    const error = await run(gh.fetch).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CanonGuardError);
    expect(error).toMatchObject({ layer: 'request', method: 'PUT' });
    expect(gh.calls.some((c) => c.startsWith('PUT'))).toBe(false);
    expect(gh.calls).toHaveLength(4);
  });

  it('refuses a PUT whose body gained a sha before fetch sees it', async () => {
    hooks.tamper = (url, init) => [
      url,
      init.method === 'PUT' ? { ...init, body: JSON.stringify({ ...JSON.parse(init.body!), sha: SHA }) } : init,
    ];
    const gh = github();
    await expect(run(gh.fetch)).rejects.toMatchObject({ name: 'CanonGuardError', layer: 'request' });
    expect(gh.calls.some((c) => c.startsWith('PUT'))).toBe(false);
  });

  it('refuses a PR turned into a non-draft before fetch sees it', async () => {
    hooks.tamper = (url, init) => [
      url,
      url.endsWith('/pulls') ? { ...init, body: JSON.stringify({ ...JSON.parse(init.body!), draft: false }) } : init,
    ];
    const gh = github();
    await expect(run(gh.fetch)).rejects.toMatchObject({ name: 'CanonGuardError', layer: 'request' });
    expect(gh.calls.some((c) => c.endsWith('/pulls'))).toBe(false);
  });

  it('refuses a read redirected to another repository before fetch sees it', async () => {
    hooks.tamper = (url, init) => [url.replace(`/repos/${OWNER}/${REPO}`, `/repos/${OWNER}/other-repo`), init];
    const gh = github();
    await expect(run(gh.fetch)).rejects.toMatchObject({ name: 'CanonGuardError', layer: 'request' });
    expect(gh.calls).toHaveLength(0);
  });
});
