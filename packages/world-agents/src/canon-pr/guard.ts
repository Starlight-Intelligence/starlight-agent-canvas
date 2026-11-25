import { CanonGuardError } from './errors.js';

/**
 * The hard rule of this module: it never modifies CANON_LOCKED.md or any
 * existing lore file. The only write it may make is one new Markdown file under
 * `.arcanea/lore/proposals/` on a new `canon/<slug>` branch, plus the branch
 * and a draft PR. Two guards here enforce that; the executor adds a third
 * (the file must not exist yet).
 */

export const PROPOSALS_DIR = '.arcanea/lore/proposals/';
export const PROPOSAL_PATH_PATTERN = /^\.arcanea\/lore\/proposals\/\d{4}-\d{2}-\d{2}-[a-z0-9]+(-[a-z0-9]+)*\.md$/;
export const CANON_BRANCH_PATTERN = /^canon\/[a-z0-9]+(-[a-z0-9]+)*$/;
const CANON_REF_PATTERN = /^refs\/heads\/canon\/[a-z0-9]+(-[a-z0-9]+)*$/;
const NAMES_CANON_LOCKED = /canon[\s_.-]*locked/i;

function refusePath(reason: string, path: unknown): never {
  throw new CanonGuardError('path', reason, undefined, typeof path === 'string' ? JSON.stringify(path) : undefined);
}

/**
 * Layer 1. Accepts only `.arcanea/lore/proposals/YYYY-MM-DD-<slug>.md`.
 * Rejects, with a specific reason, anything naming CANON_LOCKED.md, any `..`,
 * backslash, absolute path, percent-encoding or control character.
 */
export function assertProposalPathAllowed(path: unknown): asserts path is string {
  if (typeof path !== 'string') refusePath('proposal path must be a string.', path);
  if (NAMES_CANON_LOCKED.test(path)) refusePath('proposal path names CANON_LOCKED.md, which agents may never write.', path);
  if (path.includes('..')) refusePath('proposal path contains "..".', path);
  if (path.includes('\\')) refusePath('proposal path contains a backslash.', path);
  if (path.startsWith('/') || path.startsWith('~') || /^[A-Za-z]:/.test(path)) refusePath('proposal path is absolute.', path);
  if (path.includes('%')) refusePath('proposal path contains URL-encoding.', path);
  if (/[\u0000-\u001f\u007f]/.test(path)) refusePath('proposal path contains a control character.', path);
  if (!PROPOSAL_PATH_PATTERN.test(path)) {
    refusePath(`proposal path must be a new file ${PROPOSALS_DIR}YYYY-MM-DD-<slug>.md.`, path);
  }
}

/** The only GitHub API this module talks to. GitHub Enterprise is out of scope. */
export const GITHUB_API_ORIGIN = 'https://api.github.com';
export const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
export const REPO_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/;

/** The subset of RequestInit this module sends. */
export interface CanonFetchInit {
  method: string;
  headers: Record<string, string>;
  body?: string;
  /** Always 'manual': redirects are never followed. The guard forces it. */
  redirect?: 'manual';
  signal?: AbortSignal;
}

/** The subset of Response this module reads. A real `Response` satisfies it. */
export interface ResponseLike {
  status: number;
  /** 'opaqueredirect' when a runtime hides a manual redirect behind status 0. */
  type?: string;
  text(): Promise<string>;
}

/** The global `fetch` satisfies this. Tests inject a recorder. */
export type FetchLike = (url: string, init: CanonFetchInit) => Promise<ResponseLike>;

export interface CanonWriteGuardOptions {
  /** Every request, reads included, must address /repos/{owner}/{repo} on api.github.com. */
  owner: string;
  repo: string;
}

const READ_METHODS = new Set(['GET', 'HEAD']);
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH']);

function parseBody(body: string | undefined, refuse: (reason: string) => never): Record<string, unknown> {
  if (typeof body !== 'string') refuse('a write must carry a JSON string body the guard can inspect.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    refuse('write body is not valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) refuse('write body must be a JSON object.');
  // Duplicate keys or other formatting could make GitHub read a different
  // value than the one checked here, so only the canonical form is forwarded.
  if (JSON.stringify(parsed) !== body) refuse('write body is not canonical JSON (duplicate keys or extra formatting).');
  return parsed as Record<string, unknown>;
}

/**
 * Layer 2. Wraps fetch so that every request goes to
 * `https://api.github.com/repos/{owner}/{repo}` with redirects off, and the
 * only writes that reach GitHub are:
 * - POST /repos/{owner}/{repo}/git/refs creating `refs/heads/canon/<slug>`;
 * - PUT /repos/{owner}/{repo}/contents/<allowed proposal path> on a `canon/<slug>` branch, with no `sha`;
 * - POST /repos/{owner}/{repo}/pulls from `canon/<slug>`, into a non-canon base, with `draft: true`.
 * Everything else is refused before fetch is called, including any DELETE,
 * tree/blob/commit writes, ref PATCHes, PR edits and PR merges.
 */
export function createCanonWriteGuard(fetchImpl: FetchLike, options: CanonWriteGuardOptions): FetchLike {
  if (typeof options?.owner !== 'string' || !OWNER_PATTERN.test(options.owner)) {
    throw new CanonGuardError('request', 'the guard needs a valid owner.');
  }
  if (typeof options.repo !== 'string' || !REPO_PATTERN.test(options.repo) || options.repo === '.' || options.repo === '..') {
    throw new CanonGuardError('request', 'the guard needs a valid repo.');
  }
  const repoPath = `/repos/${options.owner}/${options.repo}`;

  return async (url, init) => {
    const method = String(init?.method ?? 'GET').toUpperCase();
    const refuse = (reason: string): never => {
      throw new CanonGuardError('request', reason, method, url);
    };

    if (method === 'DELETE') refuse('DELETE is never allowed.');
    if (!READ_METHODS.has(method) && !WRITE_METHODS.has(method)) refuse(`method ${method} is not allowed.`);

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return refuse('URL does not parse.');
    }
    if (parsed.origin !== GITHUB_API_ORIGIN || parsed.username || parsed.password) {
      refuse(`requests may only go to ${GITHUB_API_ORIGIN}.`);
    }
    if (parsed.pathname !== repoPath && !parsed.pathname.startsWith(`${repoPath}/`)) {
      refuse(`requests may only address ${repoPath}.`);
    }
    const forwarded: CanonFetchInit = { ...init, redirect: 'manual' };
    if (READ_METHODS.has(method)) return fetchImpl(url, forwarded);

    // Writes from here on. Refuse traversal in the raw URL before the URL
    // parser normalizes it away, so intent is checked as well as effect.
    if (url.includes('..') || /%2e/i.test(url) || url.includes('\\') || /%5c/i.test(url)) {
      refuse('write URL contains path traversal.');
    }
    if (parsed.search || parsed.hash) refuse('write URLs carry no query or fragment.');

    const rest = parsed.pathname.slice(repoPath.length);

    if (rest.startsWith('/contents/') || rest === '/contents') {
      if (method !== 'PUT') refuse(`${method} to /contents/ is not allowed; only PUT creating a new proposal file.`);
      let filePath: string;
      try {
        filePath = decodeURIComponent(rest.slice('/contents/'.length));
      } catch {
        return refuse('contents path does not decode.');
      }
      try {
        assertProposalPathAllowed(filePath);
      } catch (error) {
        refuse(`contents path ${JSON.stringify(filePath)} is not an allowed proposal path (${(error as CanonGuardError).reason})`);
      }
      // Checked again here so this layer does not rely on layer 1 alone.
      if (!PROPOSAL_PATH_PATTERN.test(filePath) || NAMES_CANON_LOCKED.test(filePath)) {
        refuse(`contents path ${JSON.stringify(filePath)} is outside ${PROPOSALS_DIR}.`);
      }
      const body = parseBody(init.body, refuse);
      if ('sha' in body) refuse('contents write carries a sha, which would overwrite an existing file.');
      if (typeof body.branch !== 'string' || !CANON_BRANCH_PATTERN.test(body.branch)) {
        refuse('contents write must target a canon/<slug> branch.');
      }
      return fetchImpl(url, forwarded);
    }

    if (rest === '/git/refs') {
      if (method !== 'POST') refuse(`${method} to /git/refs is not allowed.`);
      const body = parseBody(init.body, refuse);
      if (typeof body.ref !== 'string' || !CANON_REF_PATTERN.test(body.ref)) {
        refuse('ref writes may only create refs/heads/canon/<slug>.');
      }
      return fetchImpl(url, forwarded);
    }
    if (rest.startsWith('/git/refs/')) refuse('updating an existing ref can move a branch and is never allowed.');
    if (/^\/git\/(trees|blobs|commits)(\/|$)/.test(rest)) refuse('tree, blob and commit writes can change arbitrary files and are never allowed.');
    if (rest.startsWith('/git/')) refuse('git database writes are not allowed.');

    if (rest === '/pulls') {
      if (method !== 'POST') refuse(`${method} to /pulls is not allowed.`);
      const body = parseBody(init.body, refuse);
      if (typeof body.head !== 'string' || !CANON_BRANCH_PATTERN.test(body.head)) refuse('pull requests must come from a canon/<slug> branch.');
      if (typeof body.base !== 'string' || body.base.startsWith('canon/')) refuse('pull requests must target a reviewed base branch, not a canon/ branch.');
      if (body.draft !== true) refuse('pull requests must be drafts.');
      return fetchImpl(url, forwarded);
    }

    return refuse('write is not on the canon proposal allowlist.');
  };
}
