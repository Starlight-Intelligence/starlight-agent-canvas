/** Errors raised by the canon proposal pipeline. None of them ever carry the GitHub token. */

export type CanonProposalErrorCode =
  | 'INVALID_REQUEST'
  | 'INVALID_NODE'
  | 'NODE_NOT_FOUND'
  | 'WRONG_WORLD'
  | 'DUPLICATE_NODE'
  | 'ALREADY_CANON';

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

  constructor(
    readonly layer: CanonGuardLayer,
    readonly reason: string,
    readonly method?: string,
    readonly target?: string,
  ) {
    super(method && target ? `Refused ${method} ${target}: ${reason}` : `Refused: ${reason}`);
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
  | 'HTTP_ERROR'
  | 'BRANCH_EXISTS'
  | 'FILE_EXISTS'
  | 'INVALID_RESPONSE';

/** Opening the draft PR failed at `step`. `status` and `githubMessage` are set for HTTP failures. */
export class CanonPrError extends Error {
  override readonly name = 'CanonPrError';

  constructor(
    readonly code: CanonPrErrorCode,
    readonly step: CanonPrStep,
    message: string,
    readonly status?: number,
    readonly githubMessage?: string,
  ) {
    super(message);
  }
}
