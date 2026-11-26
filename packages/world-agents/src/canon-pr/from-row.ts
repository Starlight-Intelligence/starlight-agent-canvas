import { z } from 'zod';
import { CanonProposalError } from './errors.js';
import { canonProposalRequestSchema, type CanonProposalRequest } from './request.js';

/**
 * L2's CanonProposalRow (apps/world-edge/src/store.ts): one recorded
 * propose_canon call. Typed as the server types it (plain strings); the
 * request built from it is checked with the strict canonProposalRequestSchema.
 * Unknown keys are stripped so additive server fields do not break this.
 */
export const canonProposalRowSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  nodeIds: z.array(z.string()),
  edgeIds: z.array(z.string()),
  rationale: z.string(),
  status: z.string(),
  prUrl: z.string().nullable(),
  worldVersion: z.number().int().nonnegative(),
  harness: z.string(),
  actor: z.string().nullable(),
  createdAt: z.iso.datetime({ offset: true }),
});
export type CanonProposalRow = z.infer<typeof canonProposalRowSchema>;

export interface CanonProposalRowOptions {
  /**
   * The world the row belongs to. The row itself does not carry it, so the
   * caller must pass the id of the world it read the row from; nodes are then
   * resolved by id in that world.
   */
  worldId: string;
}

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  return `${issue?.path.join('.') || '(root)'}: ${issue?.message ?? 'invalid'}`;
}

/**
 * Turns an L2 canon proposal row into a canon proposal request for
 * buildCanonProposal. The date is the UTC date of `createdAt`. A null actor is
 * left out. Throws CanonProposalError: NOT_OPEN when the row is not `open` or
 * already has a PR URL, UNSUPPORTED_TARGET when the row names
 * edges (edge proposals are not supported here yet, and are never dropped
 * silently), INVALID_REQUEST when the row or the resulting request is invalid.
 * buildCanonProposal can still throw CanonGuardError later, for example for a
 * title that names CANON_LOCKED.
 */
export function canonProposalRequestFromRow(row: unknown, options: CanonProposalRowOptions): CanonProposalRequest {
  const parsedRow = canonProposalRowSchema.safeParse(row);
  if (!parsedRow.success) {
    throw new CanonProposalError('INVALID_REQUEST', `Invalid canon proposal row at ${firstIssue(parsedRow.error)}`);
  }
  const r = parsedRow.data;
  if (r.status !== 'open' || r.prUrl !== null) {
    throw new CanonProposalError(
      'NOT_OPEN',
      `Canon proposal ${r.id} is not open (status ${JSON.stringify(r.status)}${r.prUrl === null ? '' : ', it already has a PR'}); refusing to build a second PR.`,
    );
  }
  if (r.edgeIds.length > 0) {
    throw new CanonProposalError(
      'UNSUPPORTED_TARGET',
      `Canon proposal ${r.id} includes ${r.edgeIds.length === 1 ? '1 edge' : `${r.edgeIds.length} edges`}; edge proposals are not supported by canon-pr yet, so nothing was built.`,
    );
  }
  const request = {
    worldId: options?.worldId,
    title: r.title,
    nodeIds: r.nodeIds,
    rationale: r.rationale,
    proposer: r.actor === null ? { harness: r.harness } : { harness: r.harness, actor: r.actor },
    date: new Date(r.createdAt).toISOString().slice(0, 10),
  };
  const parsedRequest = canonProposalRequestSchema.safeParse(request);
  if (!parsedRequest.success) {
    throw new CanonProposalError('INVALID_REQUEST', `Canon proposal ${r.id} does not make a valid request at ${firstIssue(parsedRequest.error)}`);
  }
  return parsedRequest.data;
}
