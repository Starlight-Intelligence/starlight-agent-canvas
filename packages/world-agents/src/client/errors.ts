import type { z } from 'zod';

/** Base class for every error the world client throws. */
export class WorldClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Bad client or transport configuration, detected before any network call. */
export class WorldClientConfigError extends WorldClientError {}

/** The server rejected the credentials (HTTP 401 or 403). */
export class WorldAuthError extends WorldClientError {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/** HTTP or MCP protocol failure that is not a tool error. */
export class WorldTransportError extends WorldClientError {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

export interface WorldToolErrorDetail {
  /** An op error code from spec 4.2 (for example STALE_VERSION), an L2 code (INVALID_INPUT, BOUNDS_TOO_LARGE), or a client-side code (TOOL_ERROR, RPC_ERROR). */
  code: string;
  message: string;
  opIndex?: number;
  id?: string;
  expectedVersion?: number;
  actualVersion?: number;
  /** World version the server reported with the failure (L2's `version` next to `error`). */
  worldVersion?: number;
  /** JSON-RPC error code, when the error came from a JSON-RPC error response. */
  rpcCode?: number;
}

/** A tool call failed on the server (tool result with isError, or a JSON-RPC error). */
export class WorldToolError extends WorldClientError {
  readonly tool: string;
  readonly code: string;
  readonly opIndex?: number;
  readonly id?: string;
  readonly expectedVersion?: number;
  readonly actualVersion?: number;
  readonly worldVersion?: number;
  readonly rpcCode?: number;

  constructor(tool: string, detail: WorldToolErrorDetail) {
    super(`${tool} failed with ${detail.code}: ${detail.message}`);
    this.tool = tool;
    this.code = detail.code;
    if (detail.opIndex !== undefined) this.opIndex = detail.opIndex;
    if (detail.id !== undefined) this.id = detail.id;
    if (detail.expectedVersion !== undefined) this.expectedVersion = detail.expectedVersion;
    if (detail.actualVersion !== undefined) this.actualVersion = detail.actualVersion;
    if (detail.worldVersion !== undefined) this.worldVersion = detail.worldVersion;
    if (detail.rpcCode !== undefined) this.rpcCode = detail.rpcCode;
  }

  /** True when the target changed since the client read it. Re-read and retry. */
  get isStale(): boolean {
    return this.code === 'STALE_VERSION';
  }
}

/** Tool input or output did not match the client-side contract in tools.ts. */
export class WorldClientValidationError extends WorldClientError {
  constructor(
    readonly tool: string,
    readonly direction: 'input' | 'output',
    readonly issues: z.core.$ZodIssue[],
  ) {
    super(`Invalid ${direction} for ${tool}: ${formatIssues(issues)}`);
  }
}

function formatIssues(issues: readonly z.core.$ZodIssue[]): string {
  const shown = issues.slice(0, 5).map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`);
  if (issues.length > shown.length) shown.push(`and ${issues.length - shown.length} more`);
  return shown.join('; ');
}
