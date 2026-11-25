import { CanonGuardError, CanonPrError, type CanonPrStep } from './errors.js';
import { assertProposalPathAllowed, CANON_BRANCH_PATTERN, createCanonWriteGuard, type FetchLike } from './guard.js';
import type { CanonProposalFile } from './proposal.js';

/** GitHub REST API version header. Still fully supported per GitHub's API versions page. */
export const GITHUB_API_VERSION = '2022-11-28';
export const DEFAULT_GITHUB_API_BASE_URL = 'https://api.github.com';
export const GITHUB_USER_AGENT = 'starlight-agent-canvas-world-agents';

/** Shown in planned calls when the value is only known at run time. */
export const DEFAULT_BRANCH_PLACEHOLDER = '{default_branch}';
export const BASE_SHA_PLACEHOLDER = '{base_sha}';

export interface CanonPrTarget {
  owner: string;
  repo: string;
  /** Branch the PR targets. When omitted the repository's default branch is looked up. */
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

export interface ExecutedCall {
  step: PlannedCall['step'];
  method: PlannedCall['method'];
  path: string;
  status: number;
  purpose: string;
}

export interface OpenCanonPrOptions extends CanonPrTarget {
  /** Returns the GitHub token. Called once per run, right before the first request. */
  getToken: () => string | Promise<string>;
  fetch: FetchLike;
  apiBaseUrl?: string;
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

const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/;
const BRANCH_NAME_PATTERN = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

function isPlainBranch(name: unknown): name is string {
  return typeof name === 'string' && BRANCH_NAME_PATTERN.test(name) && !name.includes('..');
}

function checkTarget(target: CanonPrTarget): void {
  if (typeof target.owner !== 'string' || !OWNER_PATTERN.test(target.owner)) invalid('owner is required and must be a GitHub account name.');
  if (typeof target.repo !== 'string' || !REPO_PATTERN.test(target.repo) || target.repo === '.' || target.repo === '..') {
    invalid('repo is required and must be a GitHub repository name.');
  }
  if (target.base !== undefined && !isPlainBranch(target.base)) {
    invalid('base must be a plain branch name.');
  }
}

/** Layer 1 runs here, before any token is fetched or request is sent. */
function checkProposal(proposal: CanonProposalFile): void {
  assertProposalPathAllowed(proposal.path);
  if (typeof proposal.branch !== 'string' || !CANON_BRANCH_PATTERN.test(proposal.branch) || proposal.branch !== `canon/${proposal.slug}`) {
    invalid('proposal branch must be canon/<slug>.');
  }
  if (!proposal.path.endsWith(`-${proposal.slug}.md`)) invalid('proposal path does not match its slug.');
  for (const key of ['markdown', 'commitMessage', 'prTitle', 'prBody'] as const) {
    if (typeof proposal[key] !== 'string' || proposal[key].length === 0) invalid(`proposal.${key} must be a non-empty string.`);
  }
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
  checkTarget(target);
  checkProposal(proposal);
  const base = target.base ?? null;
  const steps: PlannedCall['step'][] = base === null
    ? ['get-repo', 'get-base-ref', 'create-branch', 'check-file', 'put-file', 'open-pr']
    : ['get-base-ref', 'create-branch', 'check-file', 'put-file', 'open-pr'];
  return steps.map((step) => callFor(step, proposal, target, base, null));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/**
 * Executes the plan: branch, existence check, new file, draft PR. The token
 * comes only from `getToken`, is used only in the Authorization header, and is
 * redacted from every error message. Every request passes the write guard.
 * If a step after branch creation fails, the branch is left in place; this
 * module never deletes anything.
 */
export async function openCanonPr(proposal: CanonProposalFile, options: OpenCanonPrOptions): Promise<OpenCanonPrResult> {
  checkTarget(options);
  checkProposal(proposal);
  if (typeof options.fetch !== 'function') invalid('fetch is required.');
  if (typeof options.getToken !== 'function') invalid('getToken is required.');
  const apiBaseUrl = (options.apiBaseUrl ?? DEFAULT_GITHUB_API_BASE_URL).replace(/\/+$/, '');
  let apiUrl: URL;
  try {
    apiUrl = new URL(apiBaseUrl);
  } catch {
    return invalid('apiBaseUrl must be an absolute URL.');
  }
  if (apiUrl.protocol !== 'https:') invalid('apiBaseUrl must use https.');

  let token: string;
  try {
    token = await options.getToken();
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

  const guardedFetch = createCanonWriteGuard(options.fetch, { apiBaseUrl });
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
      response = await guardedFetch(`${apiBaseUrl}${call.path}`, {
        method: call.method,
        headers: call.body ? { ...headers, 'Content-Type': 'application/json' } : headers,
        ...(call.body ? { body: JSON.stringify(call.body) } : {}),
      });
    } catch (error) {
      if (error instanceof CanonGuardError) throw error;
      const detail = error instanceof Error ? error.message : String(error);
      throw new CanonPrError('NETWORK_ERROR', call.step, redact(`${call.method} ${call.path} failed before a response: ${detail}`));
    }
    calls.push({ step: call.step, method: call.method, path: call.path, status: response.status, purpose: call.purpose });
    let data: Record<string, unknown> = {};
    try {
      data = asRecord(JSON.parse(await response.text()));
    } catch {
      // Empty or non-JSON body; status alone decides.
    }
    return { status: response.status, data };
  };

  const httpError = (step: PlannedCall['step'], status: number, data: Record<string, unknown>, code: 'HTTP_ERROR' | 'BRANCH_EXISTS' | 'FILE_EXISTS' = 'HTTP_ERROR', note = ''): never => {
    const githubMessage = typeof data.message === 'string' ? redact(data.message) : undefined;
    throw new CanonPrError(code, step, `GitHub ${step} failed with ${status}${githubMessage ? `: ${githubMessage}` : ''}${note}`, status, githubMessage);
  };
  const ok = (status: number) => status >= 200 && status < 300;

  let base = options.base ?? null;
  if (base === null) {
    const res = await send(callFor('get-repo', proposal, options, null, null));
    if (!ok(res.status)) httpError('get-repo', res.status, res.data);
    if (!isPlainBranch(res.data.default_branch)) {
      throw new CanonPrError('INVALID_RESPONSE', 'get-repo', 'GitHub did not return a usable default_branch.');
    }
    base = res.data.default_branch;
  }

  const ref = await send(callFor('get-base-ref', proposal, options, base, null));
  if (!ok(ref.status)) httpError('get-base-ref', ref.status, ref.data);
  const sha = asRecord(ref.data.object).sha;
  if (typeof sha !== 'string' || !/^[0-9a-f]{40,64}$/.test(sha)) {
    throw new CanonPrError('INVALID_RESPONSE', 'get-base-ref', `GitHub did not return a commit sha for ${base}.`);
  }

  const created = await send(callFor('create-branch', proposal, options, base, sha));
  if (created.status === 422) {
    httpError('create-branch', 422, created.data, 'BRANCH_EXISTS', `. Branch ${proposal.branch} already exists; it is never reused. Pick another slug.`);
  }
  if (!ok(created.status)) httpError('create-branch', created.status, created.data);

  const existing = await send(callFor('check-file', proposal, options, base, sha));
  if (ok(existing.status)) {
    throw new CanonPrError('FILE_EXISTS', 'check-file', `${proposal.path} already exists on ${proposal.branch}; nothing was written.`, existing.status);
  }
  if (existing.status !== 404) httpError('check-file', existing.status, existing.data);

  const put = await send(callFor('put-file', proposal, options, base, sha));
  if (!ok(put.status)) httpError('put-file', put.status, put.data);

  const pr = await send(callFor('open-pr', proposal, options, base, sha));
  if (!ok(pr.status)) httpError('open-pr', pr.status, pr.data);
  const prNumber = pr.data.number;
  const prUrl = pr.data.html_url;
  if (typeof prNumber !== 'number' || !Number.isInteger(prNumber) || typeof prUrl !== 'string') {
    throw new CanonPrError('INVALID_RESPONSE', 'open-pr', 'GitHub did not return the pull request number and URL.');
  }

  return { prUrl, prNumber, branch: proposal.branch, path: proposal.path, calls };
}
