import { CanonGuardError, CanonPrError, type CanonPrErrorCode, type CanonPrStep, type ExecutedCall } from './errors.js';
import {
  assertProposalPathAllowed,
  CANON_BRANCH_PATTERN,
  createCanonWriteGuard,
  GITHUB_API_ORIGIN,
  OWNER_PATTERN,
  REPO_PATTERN,
  type FetchLike,
} from './guard.js';
import type { CanonProposalFile } from './proposal.js';

export type { ExecutedCall } from './errors.js';

/** GitHub REST API version header. Still fully supported per GitHub's API versions page. */
export const GITHUB_API_VERSION = '2022-11-28';
/** The only accepted API base URL. GitHub Enterprise is out of scope. */
export const DEFAULT_GITHUB_API_BASE_URL = GITHUB_API_ORIGIN;
export const GITHUB_USER_AGENT = 'starlight-agent-canvas-world-agents';
export const DEFAULT_CANON_PR_TIMEOUT_MS = 30_000;
/** Largest delay timers accept (2^31 - 1 ms); larger values overflow and fire at once. */
const MAX_CANON_PR_TIMEOUT_MS = 2_147_483_647;

/** Shown in planned calls when the value is only known at run time. */
export const DEFAULT_BRANCH_PLACEHOLDER = '{default_branch}';
export const BASE_SHA_PLACEHOLDER = '{base_sha}';

export interface CanonPrTarget {
  owner: string;
  repo: string;
  /** Branch the PR targets. When omitted the repository's default branch is looked up. Never a canon/ branch. */
  base?: string;
}

export interface PlannedCall {
  step: Exclude<CanonPrStep, 'setup' | 'token'>;
  method: 'GET' | 'POST' | 'PUT';
  /** API path including query, relative to the API base URL. Path segments are URL-encoded. */
  path: string;
  body: Record<string, unknown> | null;
  purpose: string;
}

export interface OpenCanonPrOptions extends CanonPrTarget {
  /** Returns the GitHub token. Called once per run, right before the first request. */
  getToken: () => string | Promise<string>;
  fetch: FetchLike;
  /** Must be `https://api.github.com` (a trailing slash is allowed). Anything else is refused. */
  apiBaseUrl?: string;
  /** Per-request timeout in milliseconds. Defaults to 30000. */
  timeoutMs?: number;
}

export interface OpenCanonPrResult {
  prUrl: string;
  prNumber: number;
  branch: string;
  path: string;
  calls: ExecutedCall[];
}

/** Base64 of the UTF-8 bytes of `text`. No Buffer, so it runs in Workers. */
export function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

function invalid(message: string): never {
  throw new CanonPrError('INVALID_OPTIONS', 'setup', message);
}

const BRANCH_NAME_PATTERN = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

/** A plain branch name that is not a canon/ branch, so a proposal never stacks on an unreviewed one. */
function isReviewedBase(name: unknown): name is string {
  return typeof name === 'string' && BRANCH_NAME_PATTERN.test(name) && !name.includes('..') && !name.startsWith('canon/');
}

/** Copies the target so later reads cannot see different values than the checks did. */
function snapshotTarget(target: CanonPrTarget): CanonPrTarget {
  const { owner, repo, base } = target ?? ({} as CanonPrTarget);
  if (typeof owner !== 'string' || !OWNER_PATTERN.test(owner)) invalid('owner is required and must be a GitHub account name.');
  if (typeof repo !== 'string' || !REPO_PATTERN.test(repo) || repo === '.' || repo === '..') {
    invalid('repo is required and must be a GitHub repository name.');
  }
  if (base !== undefined && !isReviewedBase(base)) invalid('base must be a plain branch name and must not be a canon/ branch.');
  return base === undefined ? { owner, repo } : { owner, repo, base };
}

/**
 * Copies the proposal and checks the copy. Layer 1 runs here, before any token
 * is fetched or request is sent, and the copy is what every request is built from.
 */
function snapshotProposal(proposal: CanonProposalFile): CanonProposalFile {
  const { slug, date, path, branch, markdown, commitMessage, prTitle, prBody } = proposal ?? ({} as CanonProposalFile);
  const copy: CanonProposalFile = { slug, date, path, branch, markdown, commitMessage, prTitle, prBody };
  assertProposalPathAllowed(copy.path);
  if (typeof copy.branch !== 'string' || !CANON_BRANCH_PATTERN.test(copy.branch) || copy.branch !== `canon/${copy.slug}`) {
    invalid('proposal branch must be canon/<slug>.');
  }
  if (!copy.path.endsWith(`-${copy.slug}.md`)) invalid('proposal path does not match its slug.');
  for (const key of ['markdown', 'commitMessage', 'prTitle', 'prBody'] as const) {
    if (typeof copy[key] !== 'string' || copy[key].length === 0) invalid(`proposal.${key} must be a non-empty string.`);
  }
  return Object.freeze(copy);
}

function callFor(
  step: PlannedCall['step'],
  proposal: CanonProposalFile,
  target: CanonPrTarget,
  base: string | null,
  baseSha: string | null,
): PlannedCall {
  const repoPath = `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}`;
  const baseName = base ?? DEFAULT_BRANCH_PLACEHOLDER;
  const filePath = `${repoPath}/contents/${encodePath(proposal.path)}`;
  switch (step) {
    case 'get-repo':
      return { step, method: 'GET', path: repoPath, body: null, purpose: 'Look up the default branch to use as base.' };
    case 'get-base-ref':
      return {
        step,
        method: 'GET',
        path: `${repoPath}/git/ref/heads/${base === null ? DEFAULT_BRANCH_PLACEHOLDER : encodePath(base)}`,
        body: null,
        purpose: `Read the commit sha at the tip of ${baseName}.`,
      };
    case 'create-branch':
      return {
        step,
        method: 'POST',
        path: `${repoPath}/git/refs`,
        body: { ref: `refs/heads/${proposal.branch}`, sha: baseSha ?? BASE_SHA_PLACEHOLDER },
        purpose: `Create the new branch ${proposal.branch} from ${baseName}. Fails if it already exists.`,
      };
    case 'check-file':
      return {
        step,
        method: 'GET',
        path: `${filePath}?ref=${encodeURIComponent(proposal.branch)}`,
        body: null,
        purpose: `Confirm ${proposal.path} does not exist yet (must be 404).`,
      };
    case 'put-file':
      return {
        step,
        method: 'PUT',
        path: filePath,
        body: { message: proposal.commitMessage, content: utf8ToBase64(proposal.markdown), branch: proposal.branch },
        purpose: `Add the new proposal file ${proposal.path}. No sha is sent, so GitHub refuses to overwrite.`,
      };
    case 'open-pr':
      return {
        step,
        method: 'POST',
        path: `${repoPath}/pulls`,
        body: { title: proposal.prTitle, head: proposal.branch, base: baseName, body: proposal.prBody, draft: true },
        purpose: `Open a draft PR from ${proposal.branch} into ${baseName} for the Creator to review.`,
      };
  }
}

/**
 * The ordered GitHub REST calls that open the canon PR, as data. When `base`
 * is omitted the first call looks up the default branch, and later calls show
 * `{default_branch}` and `{base_sha}` placeholders for values known only at run time.
 */
export function planCanonPr(proposal: CanonProposalFile, target: CanonPrTarget): PlannedCall[] {
  const pinned = snapshotTarget(target);
  const fixed = snapshotProposal(proposal);
  const base = pinned.base ?? null;
  const steps: PlannedCall['step'][] = base === null
    ? ['get-repo', 'get-base-ref', 'create-branch', 'check-file', 'put-file', 'open-pr']
    : ['get-base-ref', 'create-branch', 'check-file', 'put-file', 'open-pr'];
  return steps.map((step) => callFor(step, fixed, pinned, base, null));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/**
 * Executes the plan: branch, existence check, new file, draft PR. The token
 * comes only from `getToken`, is used only in the Authorization header, and is
 * redacted from every error message. Every request passes the write guard,
 * which pins api.github.com and /repos/{owner}/{repo}. Redirects are never
 * followed. If a step after branch creation fails, the branch is left in place
 * and reported on the error; this module never deletes anything.
 */
export async function openCanonPr(proposal: CanonProposalFile, options: OpenCanonPrOptions): Promise<OpenCanonPrResult> {
  const target = snapshotTarget(options);
  const fixed = snapshotProposal(proposal);
  const { getToken, fetch: fetchImpl } = options;
  if (typeof fetchImpl !== 'function') invalid('fetch is required.');
  if (typeof getToken !== 'function') invalid('getToken is required.');
  if (options.apiBaseUrl !== undefined && options.apiBaseUrl !== GITHUB_API_ORIGIN && options.apiBaseUrl !== `${GITHUB_API_ORIGIN}/`) {
    invalid(`apiBaseUrl must be ${GITHUB_API_ORIGIN}; other hosts, ports, paths and credentials are refused.`);
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_CANON_PR_TIMEOUT_MS;
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_CANON_PR_TIMEOUT_MS) {
    invalid(`timeoutMs must be a positive number of milliseconds, at most ${MAX_CANON_PR_TIMEOUT_MS}.`);
  }

  let token: string;
  try {
    token = await getToken();
  } catch {
    throw new CanonPrError('TOKEN_UNAVAILABLE', 'token', 'getToken() failed; no request was sent.');
  }
  if (typeof token !== 'string' || token.trim().length === 0) {
    throw new CanonPrError('EMPTY_TOKEN', 'token', 'getToken() returned an empty token; no request was sent.');
  }
  if (/[\s\u0000-\u001f\u007f]/.test(token)) {
    throw new CanonPrError('INVALID_TOKEN', 'token', 'getToken() returned a token with whitespace or control characters; no request was sent.');
  }
  const redact = (text: string) => text.split(token).join('[redacted]');

  const guardedFetch = createCanonWriteGuard(fetchImpl, { owner: target.owner, repo: target.repo });
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': GITHUB_API_VERSION,
    'User-Agent': GITHUB_USER_AGENT,
  };
  const calls: ExecutedCall[] = [];

  const send = async (call: PlannedCall): Promise<{ status: number; data: Record<string, unknown> }> => {
    let response;
    try {
      response = await guardedFetch(`${GITHUB_API_ORIGIN}${call.path}`, {
        method: call.method,
        headers: call.body ? { ...headers, 'Content-Type': 'application/json' } : headers,
        ...(call.body ? { body: JSON.stringify(call.body) } : {}),
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (error instanceof CanonGuardError) throw error;
      if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
        throw new CanonPrError('TIMEOUT', call.step, `${call.method} ${call.path} got no response within ${timeoutMs} ms.`);
      }
      const detail = error instanceof Error ? error.message : String(error);
      throw new CanonPrError('NETWORK_ERROR', call.step, redact(`${call.method} ${call.path} failed before a response: ${detail}`));
    }
    const { status } = response;
    calls.push({ step: call.step, method: call.method, path: call.path, status, purpose: call.purpose });
    if (status === 0 || response.type === 'opaqueredirect' || (status >= 300 && status < 400)) {
      throw new CanonPrError(
        'REDIRECT',
        call.step,
        `GitHub answered ${call.method} ${call.path} with a redirect (status ${status}). Redirects are not followed; check owner and repo.`,
        { status },
      );
    }
    let data: Record<string, unknown> = {};
    try {
      data = asRecord(JSON.parse(await response.text()));
    } catch {
      // Empty or non-JSON body; status alone decides.
    }
    return { status, data };
  };

  const httpError = (step: PlannedCall['step'], status: number, data: Record<string, unknown>, code: CanonPrErrorCode = 'HTTP_ERROR', note = ''): never => {
    const githubMessage = typeof data.message === 'string' ? redact(data.message) : undefined;
    throw new CanonPrError(code, step, `GitHub ${step} failed with ${status}${githubMessage ? `: ${githubMessage}` : ''}${note}`, { status, githubMessage });
  };
  const ok = (status: number) => status >= 200 && status < 300;

  let base = target.base ?? null;
  if (base === null) {
    const res = await send(callFor('get-repo', fixed, target, null, null));
    if (!ok(res.status)) httpError('get-repo', res.status, res.data);
    if (!isReviewedBase(res.data.default_branch)) {
      throw new CanonPrError('INVALID_RESPONSE', 'get-repo', 'GitHub did not return a usable default_branch (a plain branch name that is not a canon/ branch).');
    }
    base = res.data.default_branch;
  }

  const ref = await send(callFor('get-base-ref', fixed, target, base, null));
  if (!ok(ref.status)) httpError('get-base-ref', ref.status, ref.data);
  const sha = asRecord(ref.data.object).sha;
  if (typeof sha !== 'string' || !/^[0-9a-f]{40,64}$/.test(sha)) {
    throw new CanonPrError('INVALID_RESPONSE', 'get-base-ref', `GitHub did not return a commit sha for ${base}.`);
  }

  let created: Awaited<ReturnType<typeof send>>;
  try {
    created = await send(callFor('create-branch', fixed, target, base, sha));
  } catch (error) {
    // No response does not mean no branch: GitHub may have created it before the connection dropped.
    if (error instanceof CanonPrError && (error.code === 'NETWORK_ERROR' || error.code === 'TIMEOUT')) {
      throw new CanonPrError(
        error.code,
        error.step,
        `${error.message} Branch ${fixed.branch} may have been created anyway; it is never reused. Check for it and retry with a different slug.`,
        { branch: fixed.branch, path: fixed.path, calls: [...calls] },
      );
    }
    throw error;
  }
  if (created.status === 422) {
    httpError('create-branch', 422, created.data, 'BRANCH_EXISTS', `. Branch ${fixed.branch} already exists; it is never reused. Pick another slug.`);
  }
  if (!ok(created.status)) httpError('create-branch', created.status, created.data);

  try {
    const existing = await send(callFor('check-file', fixed, target, base, sha));
    if (ok(existing.status)) {
      throw new CanonPrError('FILE_EXISTS', 'check-file', `${fixed.path} already exists on ${fixed.branch}; nothing was written.`, { status: existing.status });
    }
    if (existing.status !== 404) httpError('check-file', existing.status, existing.data);

    const put = await send(callFor('put-file', fixed, target, base, sha));
    if (!ok(put.status)) httpError('put-file', put.status, put.data);

    const pr = await send(callFor('open-pr', fixed, target, base, sha));
    if (!ok(pr.status)) httpError('open-pr', pr.status, pr.data);
    const prNumber = pr.data.number;
    const prUrl = pr.data.html_url;
    if (typeof prNumber !== 'number' || !Number.isSafeInteger(prNumber) || prNumber <= 0) {
      throw new CanonPrError('INVALID_RESPONSE', 'open-pr', 'GitHub did not return a pull request number.');
    }
    // GitHub may return the canonical casing of owner and repo.
    const expectedUrl = `https://github.com/${target.owner}/${target.repo}/pull/${prNumber}`;
    if (typeof prUrl !== 'string' || prUrl.toLowerCase() !== expectedUrl.toLowerCase()) {
      throw new CanonPrError('INVALID_RESPONSE', 'open-pr', `GitHub returned a pull request URL that is not ${expectedUrl}.`);
    }
    return { prUrl, prNumber, branch: fixed.branch, path: fixed.path, calls };
  } catch (error) {
    if (error instanceof CanonGuardError) {
      // Still a guard refusal; it only gains the leftover branch.
      throw new CanonGuardError(error.layer, error.reason, error.method, error.target, {
        branch: fixed.branch,
        path: fixed.path,
        calls: [...calls],
      });
    }
    if (!(error instanceof CanonPrError)) throw error;
    throw new CanonPrError(
      error.code,
      error.step,
      `${error.message} Branch ${fixed.branch} was left in place and is not reused; retry with a different slug.`,
      { status: error.status, githubMessage: error.githubMessage, branch: fixed.branch, path: fixed.path, calls: [...calls] },
    );
  }
}
