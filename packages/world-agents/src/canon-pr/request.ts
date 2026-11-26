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
});

export type CanonProposalRequest = z.infer<typeof canonProposalRequestSchema>;
export type CanonProposalRequestInput = z.input<typeof canonProposalRequestSchema>;
