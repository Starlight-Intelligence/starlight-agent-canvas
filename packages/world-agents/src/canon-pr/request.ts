import { z } from 'zod';
import { entityIdSchema, harnessSchema, LIMITS, worldIdSchema } from '@starlight-agent-canvas/world';

export const CANON_PROPOSAL_LIMITS = {
  titleMax: LIMITS.titleMax,
  /** Matches L2's 100 targets per proposal. */
  nodesMax: 100,
  rationaleMax: 4_000,
  slugInputMax: 200,
  slugMax: 60,
} as const;

function isCalendarDate(value: string): boolean {
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

export const PROPOSAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

const notBlank = (value: string) => value.trim().length > 0;

/**
 * A request to propose one or more world nodes as canon. Strict: unknown keys
 * are rejected so a caller cannot smuggle extra fields into the PR.
 */
export const canonProposalRequestSchema = z.strictObject({
  worldId: worldIdSchema,
  title: z.string().min(1).max(CANON_PROPOSAL_LIMITS.titleMax).refine(notBlank, 'title must not be blank.'),
  nodeIds: z.array(entityIdSchema).min(1).max(CANON_PROPOSAL_LIMITS.nodesMax)
    .refine((ids) => new Set(ids).size === ids.length, 'nodeIds must be unique.'),
  rationale: z.string().min(1).max(CANON_PROPOSAL_LIMITS.rationaleMax).refine(notBlank, 'rationale must not be blank.'),
  proposer: z.strictObject({
    harness: harnessSchema,
    actor: z.string().min(1).max(200).optional(),
  }),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD.')
    .refine(isCalendarDate, 'date must be a real calendar date.').optional(),
  slug: z.string().min(1).max(CANON_PROPOSAL_LIMITS.slugInputMax).optional(),
  /**
   * Id of the recorded L2 proposal row. When set, the branch and file name
   * derive from it (not from the title), so every run for one row targets the
   * same branch and openCanonPr can find a PR an earlier run opened.
   */
  proposalId: z.string().regex(PROPOSAL_ID_PATTERN, 'proposalId must match ^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$.').optional(),
  /**
   * World version recorded with the proposal. When set, every node must still
   * be at or below it (versions come from the world-wide counter, so a node
   * changed after the proposal has a higher version) or the build fails with
   * STALE_PROPOSAL.
   */
  worldVersion: z.number().int().nonnegative().optional(),
}).refine((req) => req.proposalId === undefined || req.slug === undefined, {
  message: 'slug cannot be combined with proposalId; the branch derives from the proposal id.',
  path: ['slug'],
});

export type CanonProposalRequest = z.infer<typeof canonProposalRequestSchema>;
export type CanonProposalRequestInput = z.input<typeof canonProposalRequestSchema>;
