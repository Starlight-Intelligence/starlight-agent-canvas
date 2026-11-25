import { describe, expect, it } from 'vitest';
import type { WorldNode } from '@starlight-agent-canvas/world';
import { CanonGuardError } from './errors.js';
import { openCanonPr } from './github.js';
import { assertProposalPathAllowed, createCanonWriteGuard, PROPOSAL_PATH_PATTERN, type CanonFetchInit } from './guard.js';
import { buildCanonProposal, type CanonProposalFile } from './proposal.js';

const API = 'https://api.github.com';
const REPO = `${API}/repos/Arcanea-Labs/arcanea-ai-app`;
const GOOD_PATH = '.arcanea/lore/proposals/2026-03-14-the-glass-orchard.md';
const T0 = '2026-01-01T00:00:00.000Z';
const SHA = 'c'.repeat(40);

function node(id: string): WorldNode {
  return {
    id,
    worldId: 'testland',
    kind: 'place',
    title: `Node ${id}`,
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
}

function build(fields: { title?: string; slug?: string }): CanonProposalFile {
  return buildCanonProposal(
    { worldId: 'testland', title: 'Proposal', nodeIds: ['n1'], rationale: 'Because.', proposer: { harness: 'claude' }, date: '2026-03-14', ...fields },
    [node('n1')],
  );
}

function guardRefusal(fn: () => unknown): CanonGuardError | undefined {
  try {
    fn();
  } catch (error) {
    if (error instanceof CanonGuardError) return error;
    throw error;
  }
  return undefined;
}

/** A fake GitHub that answers every step of the happy path and records calls. */
function github(checkFileStatus = 404) {
  const calls: { method: string; url: string; body: Record<string, unknown> | null }[] = [];
  const fetch = async (url: string, init: CanonFetchInit) => {
    calls.push({ method: init.method, url, body: init.body ? JSON.parse(init.body) : null });
    const path = new URL(url).pathname;
    if (init.method === 'GET' && path.includes('/git/ref/heads/')) return Response.json({ object: { sha: SHA } });
    if (init.method === 'GET' && path.includes('/contents/')) return new Response('{}', { status: checkFileStatus });
    if (init.method === 'GET') return Response.json({ default_branch: 'main' });
    if (path.endsWith('/pulls')) {
      const [, , owner, repo] = path.split('/');
      return Response.json({ number: 7, html_url: `https://github.com/${owner}/${repo}/pull/7` }, { status: 201 });
    }
    return Response.json({}, { status: 201 });
  };
  return { fetch, calls };
}

describe('layer 1: assertProposalPathAllowed', () => {
  it.each([
    [GOOD_PATH],
    ['.arcanea/lore/proposals/2026-01-01-a.md'],
    ['.arcanea/lore/proposals/2026-12-31-gate-7-crown.md'],
  ])('accepts %s', (path) => {
    expect(() => assertProposalPathAllowed(path)).not.toThrow();
  });

  it.each([
    ['.arcanea/lore/CANON_LOCKED.md', 'CANON_LOCKED'],
    ['.arcanea/lore/proposals/2026-01-01-canon-locked.md', 'CANON_LOCKED'],
    ['.arcanea/lore/proposals/2026-01-01-canonlocked.md', 'CANON_LOCKED'],
    ['.arcanea/lore/proposals/2026-01-01-x.md/../../CANON_LOCKED.md', 'CANON_LOCKED'],
    ['.arcanea/lore/proposals/../realms/veldoria.md', '".."'],
    ['.arcanea/lore/proposals/2026-01-01-x..md', '".."'],
    ['.arcanea\\lore\\proposals\\2026-01-01-x.md', 'backslash'],
    ['/.arcanea/lore/proposals/2026-01-01-x.md', 'absolute'],
    ['C:/repo/.arcanea/lore/proposals/2026-01-01-x.md', 'absolute'],
    ['~/.arcanea/lore/proposals/2026-01-01-x.md', 'absolute'],
    ['.arcanea/lore/proposals/%2e%2e/realms/veldoria.md', 'URL-encoding'],
    ['.arcanea/lore/proposals/%2E%2E%2Frealms%2Fveldoria.md', 'URL-encoding'],
    ['.arcanea%2Flore%2Fproposals%2F2026-01-01-x.md', 'URL-encoding'],
    ['.arcanea/lore/proposals/2026-01-01-x.md\n', 'control character'],
    ['.arcanea/lore/proposals/2026-01-01-x.md\u0000', 'control character'],
    ['.arcanea/lore/realms/veldoria.md', 'new file'],
    ['.arcanea/lore/proposals/sub/2026-01-01-x.md', 'new file'],
    ['.arcanea/lore/proposals/2026-01-01-X.md', 'new file'],
    ['.arcanea/lore/proposals/2026-01-01-x.markdown', 'new file'],
    ['.arcanea/lore/proposals/2026-01-01-.md', 'new file'],
    ['.arcanea/lore/proposals/2026-01-01-a--b.md', 'new file'],
    ['.arcanea/lore/proposals/x.md', 'new file'],
    ['./.arcanea/lore/proposals/2026-01-01-x.md', 'new file'],
    ['', 'new file'],
  ])('rejects %j', (path, reason) => {
    const error = guardRefusal(() => assertProposalPathAllowed(path));
    expect(error?.layer).toBe('path');
    expect(error?.reason).toContain(reason);
  });

  it('rejects non-strings', () => {
    expect(guardRefusal(() => assertProposalPathAllowed(undefined))?.layer).toBe('path');
    expect(guardRefusal(() => assertProposalPathAllowed(42))?.layer).toBe('path');
  });

  it('stops openCanonPr before the token or any request when the path is tampered', async () => {
    const gh = github();
    let tokenCalls = 0;
    const good = build({});
    for (const path of ['.arcanea/lore/CANON_LOCKED.md', '.arcanea/lore/proposals/../CANON_LOCKED.md', '.arcanea/lore/realms/veldoria.md']) {
      const tampered = { ...good, path };
      await expect(openCanonPr(tampered, {
        owner: 'Arcanea-Labs',
        repo: 'arcanea-ai-app',
        getToken: () => { tokenCalls++; return 'tok'; },
        fetch: gh.fetch,
      })).rejects.toMatchObject({ name: 'CanonGuardError', layer: 'path' });
    }
    expect(tokenCalls).toBe(0);
    expect(gh.calls).toHaveLength(0);
  });
});

describe('layer 2: createCanonWriteGuard', () => {
  const contentsUrl = `${REPO}/contents/${GOOD_PATH}`;
  const putBody = { message: 'm', content: 'eA==', branch: 'canon/the-glass-orchard' };

  function guarded() {
    const passed: string[] = [];
    const inits: CanonFetchInit[] = [];
    const inner = async (url: string, init: CanonFetchInit) => {
      passed.push(`${init.method} ${url}`);
      inits.push(init);
      return new Response('{}', { status: 200 });
    };
    return { fetch: createCanonWriteGuard(inner, { owner: 'Arcanea-Labs', repo: 'arcanea-ai-app' }), passed, inits };
  }

  const json = (value: unknown) => JSON.stringify(value);

  it.each([
    ['GET', `${REPO}`, undefined],
    ['GET', `${REPO}/contents/.arcanea/lore/CANON_LOCKED.md`, undefined],
    ['HEAD', `${REPO}/git/ref/heads/main`, undefined],
    ['POST', `${REPO}/git/refs`, json({ ref: 'refs/heads/canon/the-glass-orchard', sha: SHA })],
    ['PUT', contentsUrl, json(putBody)],
    ['PUT', `${REPO}/contents/.arcanea/lore/proposals/2026-03-14-the-glass-orchard.md`, json(putBody)],
    ['POST', `${REPO}/pulls`, json({ title: 't', head: 'canon/the-glass-orchard', base: 'main', body: 'b', draft: true })],
  ])('lets %s %s through', async (method, url, body) => {
    const g = guarded();
    await g.fetch(url, { method, headers: {}, ...(body ? { body } : {}) });
    expect(g.passed).toEqual([`${method} ${url}`]);
    expect(g.inits[0]!.redirect).toBe('manual');
  });

  it('needs a valid owner and repo to pin', () => {
    const inner = async () => new Response('{}');
    for (const pin of [{ owner: '', repo: 'r' }, { owner: 'o/x', repo: 'r' }, { owner: 'o', repo: '..' }, { owner: 'o', repo: 'r/x' }]) {
      expect(() => createCanonWriteGuard(inner, pin)).toThrow(CanonGuardError);
    }
  });

  it.each([
    ['any DELETE of a contents path', 'DELETE', contentsUrl, json({ message: 'm', sha: SHA })],
    ['DELETE of a canon branch', 'DELETE', `${REPO}/git/refs/heads/canon/the-glass-orchard`, undefined],
    ['DELETE with lowercase method', 'delete', `${REPO}/git/refs/heads/main`, undefined],
    ['unknown method', 'OPTIONS', contentsUrl, undefined],
    ['PUT to CANON_LOCKED.md', 'PUT', `${REPO}/contents/.arcanea/lore/CANON_LOCKED.md`, json(putBody)],
    ['PUT to an existing lore file', 'PUT', `${REPO}/contents/.arcanea/lore/realms/veldoria.md`, json(putBody)],
    ['PUT with raw traversal', 'PUT', `${REPO}/contents/.arcanea/lore/proposals/../CANON_LOCKED.md`, json(putBody)],
    ['PUT with encoded traversal', 'PUT', `${REPO}/contents/.arcanea/lore/proposals/%2e%2e/CANON_LOCKED.md`, json(putBody)],
    ['PUT with encoded slashes', 'PUT', `${REPO}/contents/.arcanea%2Flore%2FCANON_LOCKED.md`, json(putBody)],
    ['PUT with double-encoded path', 'PUT', `${REPO}/contents/.arcanea/lore/proposals/2026-03-14-x%252e.md`, json(putBody)],
    ['PUT with encoded backslash', 'PUT', `${REPO}/contents/.arcanea/lore/proposals%5C2026-03-14-x.md`, json(putBody)],
    ['PUT with a sha (overwrite)', 'PUT', contentsUrl, json({ ...putBody, sha: SHA })],
    ['PUT to the default branch', 'PUT', contentsUrl, json({ message: 'm', content: 'eA==' })],
    ['PUT to main', 'PUT', contentsUrl, json({ ...putBody, branch: 'main' })],
    ['PUT without a body', 'PUT', contentsUrl, undefined],
    ['PUT with a non-JSON body', 'PUT', contentsUrl, 'sha=abc'],
    ['POST to contents', 'POST', contentsUrl, json(putBody)],
    ['PATCH to contents', 'PATCH', contentsUrl, json(putBody)],
    ['POST git/trees', 'POST', `${REPO}/git/trees`, json({ tree: [{ path: '.arcanea/lore/CANON_LOCKED.md' }] })],
    ['POST git/blobs', 'POST', `${REPO}/git/blobs`, json({ content: 'x' })],
    ['POST git/commits', 'POST', `${REPO}/git/commits`, json({ message: 'm', tree: SHA })],
    ['POST git/tags', 'POST', `${REPO}/git/tags`, json({ tag: 'v1' })],
    ['PATCH a ref (move main)', 'PATCH', `${REPO}/git/refs/heads/main`, json({ sha: SHA, force: true })],
    ['PATCH a canon ref', 'PATCH', `${REPO}/git/refs/heads/canon/x`, json({ sha: SHA })],
    ['create a non-canon branch', 'POST', `${REPO}/git/refs`, json({ ref: 'refs/heads/main', sha: SHA })],
    ['create a tag ref', 'POST', `${REPO}/git/refs`, json({ ref: 'refs/tags/canon/x', sha: SHA })],
    ['create a nested traversal ref', 'POST', `${REPO}/git/refs`, json({ ref: 'refs/heads/canon/../main', sha: SHA })],
    ['non-draft PR', 'POST', `${REPO}/pulls`, json({ head: 'canon/x', base: 'main', draft: false })],
    ['PR from a non-canon head', 'POST', `${REPO}/pulls`, json({ head: 'main', base: 'release', draft: true })],
    ['merge a PR', 'PUT', `${REPO}/pulls/1/merge`, json({ merge_method: 'squash' })],
    ['edit a PR', 'PATCH', `${REPO}/pulls/1`, json({ draft: false })],
    ['comment on an issue', 'POST', `${REPO}/issues/1/comments`, json({ body: 'approved' })],
    ['repo settings', 'PATCH', `${REPO}`, json({ default_branch: 'canon/x' })],
    ['PATCH /pulls', 'PATCH', `${REPO}/pulls`, json({ head: 'canon/x', base: 'main', draft: true })],
    ['PR into a canon/ base', 'POST', `${REPO}/pulls`, json({ head: 'canon/x', base: 'canon/other', draft: true })],
    ['PR without a base', 'POST', `${REPO}/pulls`, json({ head: 'canon/x', draft: true })],
    ['duplicate keys hiding a main branch', 'PUT', contentsUrl, '{"message":"m","content":"eA==","branch":"main","branch":"canon/x"}'],
    ['duplicate keys hiding a main ref', 'POST', `${REPO}/git/refs`, `{"ref":"refs/heads/main","ref":"refs/heads/canon/x","sha":"${SHA}"}`],
    ['non-canonical JSON formatting', 'POST', `${REPO}/git/refs`, JSON.stringify({ ref: 'refs/heads/canon/x', sha: SHA }, null, 2)],
    ['a write with a query string', 'POST', `${REPO}/git/refs?force=true`, json({ ref: 'refs/heads/canon/x', sha: SHA })],
    ['a write outside /repos', 'POST', `${API}/gists`, json({ files: {} })],
    ['a read outside /repos', 'GET', `${API}/user`, undefined],
    ['a read of another repo', 'GET', `${API}/repos/Arcanea-Labs/other-repo`, undefined],
    ['a read of a repo sharing the prefix', 'GET', `${API}/repos/Arcanea-Labs/arcanea-ai-app-evil`, undefined],
    ['a read of another owner', 'GET', `${API}/repos/evil/arcanea-ai-app/contents/x`, undefined],
    ['a differently cased owner', 'GET', `${API}/repos/arcanea-labs/arcanea-ai-app`, undefined],
    ['a read escaping the repo with ..', 'GET', `${REPO}/../other-repo`, undefined],
    ['a write to another repo', 'PUT', `${API}/repos/Arcanea-Labs/other-repo/contents/${GOOD_PATH}`, json(putBody)],
    ['another host', 'PUT', `https://evil.example.com/repos/Arcanea-Labs/arcanea-ai-app/contents/${GOOD_PATH}`, json(putBody)],
    ['a read on another host', 'GET', 'https://evil.example.com/repos/Arcanea-Labs/arcanea-ai-app', undefined],
    ['plain http', 'GET', 'http://api.github.com/repos/Arcanea-Labs/arcanea-ai-app', undefined],
    ['another port', 'GET', 'https://api.github.com:8443/repos/Arcanea-Labs/arcanea-ai-app', undefined],
    ['userinfo in the URL', 'GET', 'https://user:pass@api.github.com/repos/Arcanea-Labs/arcanea-ai-app', undefined],
    ['a host that only starts with api.github.com', 'GET', 'https://api.github.com.evil.example/repos/Arcanea-Labs/arcanea-ai-app', undefined],
  ])('refuses %s', async (_label, method, url, body) => {
    const g = guarded();
    await expect(g.fetch(url, { method, headers: {}, ...(body !== undefined ? { body } : {}) }))
      .rejects.toMatchObject({ name: 'CanonGuardError', layer: 'request' });
    expect(g.passed).toHaveLength(0);
  });
});

describe('layer 3: existence pre-check', () => {
  it('makes zero PUT calls when the proposal file already exists', async () => {
    const gh = github(200);
    await expect(openCanonPr(build({}), { owner: 'o', repo: 'r', base: 'main', getToken: () => 'tok', fetch: gh.fetch }))
      .rejects.toMatchObject({ name: 'CanonPrError', code: 'FILE_EXISTS' });
    expect(gh.calls.map((c) => c.method)).toEqual(['GET', 'POST', 'GET']);
    expect(gh.calls.some((c) => c.method === 'PUT')).toBe(false);
  });
});

describe('malicious titles and slugs', () => {
  it.each([
    [{ title: 'CANON_LOCKED' }],
    [{ title: '../CANON_LOCKED' }],
    [{ title: 'Canon Locked' }],
    [{ slug: '../CANON_LOCKED' }],
    [{ slug: '..\\..\\CANON_LOCKED.md' }],
    [{ slug: 'CANON_LOCKED.md' }],
  ])('%j is refused before anything is built', (fields) => {
    expect(guardRefusal(() => build(fields))?.layer).toBe('path');
  });

  it.each([
    [{ title: '%2e%2e/' }, '2026-03-14-2e-2e.md'],
    [{ slug: '%2e%2e/%2e%2e/lore' }, '2026-03-14-2e-2e-2e-2e-lore.md'],
    [{ slug: '../../realms/veldoria' }, '2026-03-14-realms-veldoria.md'],
    [{ title: '/etc/passwd' }, '2026-03-14-etc-passwd.md'],
    [{ slug: '.arcanea/lore/realms/veldoria.md' }, '2026-03-14-arcanea-lore-realms-veldoria-md.md'],
  ])('%j can only write a new file inside proposals/', async (fields, fileName) => {
    const proposal = build(fields);
    expect(proposal.path).toBe(`.arcanea/lore/proposals/${fileName}`);
    const gh = github();
    await openCanonPr(proposal, { owner: 'o', repo: 'r', base: 'main', getToken: () => 'tok', fetch: gh.fetch });
    const writes = gh.calls.filter((c) => c.method !== 'GET');
    const puts = writes.filter((c) => c.method === 'PUT');
    expect(puts).toHaveLength(1);
    const written = decodeURIComponent(new URL(puts[0]!.url).pathname.replace('/repos/o/r/contents/', ''));
    expect(written).toBe(proposal.path);
    expect(written).toMatch(PROPOSAL_PATH_PATTERN);
    expect(puts[0]!.body).not.toHaveProperty('sha');
    expect(writes.map((c) => new URL(c.url).pathname)).toEqual(['/repos/o/r/git/refs', `/repos/o/r/contents/${proposal.path}`, '/repos/o/r/pulls']);
  });
});
