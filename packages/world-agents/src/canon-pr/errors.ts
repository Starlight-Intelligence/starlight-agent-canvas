/** Errors raised by the canon proposal pipeline. None of them ever carry the GitHub token. */

export type CanonProposalErrorCode =
  | 'INVALID_REQUEST'
  | 'INVALID_NODE'
  | 'NODE_NOT_FOUND'
  | 'WRONG_WORLD'
  | 'DUPLICATE_NODE'
  | 'ALREADY_CANON'
  | 'UNSUPPORTED_TARGET';

/** The proposal request or its nodes are not acceptable. Nothing was built. */
export class CanonProposalError extends Error {
  override readonly name = 'CanonProposalError';

  constructor(
    readonly code: CanonProposalErrorCode,
    message: string,
    readonly nodeId?: string,
  ) {
    super(message);
  }
}

export type CanonGuardLayer = 'path' | 'request';

/**
 * A write was refused because it could touch canon or an existing lore file.
 * `layer` says which guard refused it: the proposal path guard or the fetch guard.
 */
export class CanonGuardError extends Error {
  override readonly name = 'CanonGuardError';
  /** Set when the refusal came after the canon branch was created; the branch was left in place. */
  readonly branch?: string;
  readonly path?: string;
  /** Requests made before the refusal, set together with `branch`. */
  readonly calls?: readonly ExecutedCall[];

  constructor(
    readonly layer: CanonGuardLayer,
    readonly reason: string,
    readonly method?: string,
    readonly target?: string,
    leftover?: { branch: string; path: string; calls: readonly ExecutedCall[] },
  ) {
    const refused = method && target ? `Refused ${method} ${target}: ${reason}` : `Refused: ${reason}`;
    super(leftover
      ? `${refused} Branch ${leftover.branch} was created before this refusal and was left in place; it is not reused.`
      : refused);
    if (leftover) {
      this.branch = leftover.branch;
      this.path = leftover.path;
      this.calls = leftover.calls;
    }
  }
}

export type CanonPrStep =
  | 'setup'
  | 'token'
  | 'get-repo'
  | 'get-base-ref'
  | 'create-branch'
  | 'check-file'
  | 'put-file'
  | 'open-pr';

export type CanonPrErrorCode =
  | 'INVALID_OPTIONS'
  | 'EMPTY_TOKEN'
  | 'INVALID_TOKEN'
  | 'TOKEN_UNAVAILABLE'
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'REDIRECT'
  | 'HTTP_ERROR'
  | 'BRANCH_EXISTS'
  | 'FILE_EXISTS'
  | 'INVALID_RESPONSE';

/** One GitHub request that got a response. Never includes headers or the token. */
export interface ExecutedCall {
  step: Exclude<CanonPrStep, 'setup' | 'token'>;
  method: 'GET' | 'POST' | 'PUT';
  path: string;
  status: number;
  purpose: string;
}

export interface CanonPrErrorDetails {
  status?: number;
  githubMessage?: string;
  /** Set when the failure came after the canon branch was created; the branch was left in place. */
  branch?: string;
  path?: string;
  /** Requests made before the failure, set together with `branch`. */
  calls?: readonly ExecutedCall[];
}

/** Opening the draft PR failed at `step`. `status` and `githubMessage` are set for HTTP failures. */
export class CanonPrError extends Error {
  override readonly name = 'CanonPrError';
  readonly status?: number;
  readonly githubMessage?: string;
  readonly branch?: string;
  readonly path?: string;
  readonly calls?: readonly ExecutedCall[];

  constructor(
    readonly code: CanonPrErrorCode,
    readonly step: CanonPrStep,
    message: string,
    details: CanonPrErrorDetails = {},
  ) {
    super(message);
    this.status = details.status;
    this.githubMessage = details.githubMessage;
    this.branch = details.branch;
    this.path = details.path;
    this.calls = details.calls;
  }
}
