import { describe, expect, it } from 'vitest';
import type { WorldNode } from '@starlight-agent-canvas/world';
import { CanonProposalError } from './errors.js';
import { canonProposalRequestFromRow } from './from-row.js';
import { buildCanonProposal } from './proposal.js';

/** Shape of L2's CanonProposalRow as world-agent.ts proposeCanon inserts it and store.ts listProposals returns it. */
const row = {
  id: 'cp_canon_0833jf26tji',
  title: 'The Glass Orchard',
  nodeIds: ['n_orchard', 'n_keeper'],
  edgeIds: [] as string[],
  rationale: 'The orchard and its keeper recur across three drafts.',
  status: 'open',
  prUrl: null as string | null,
  worldVersion: 12,
  harness: 'claude',
  actor: 'svc-claude' as string | null,
  createdAt: '2026-11-25T23:30:00.000Z',
};

const T0 = '2026-01-01T00:00:00.000Z';
function node(id: string): WorldNode {
  return {
    id, worldId: 'testland', kind: 'place', title: `Node ${id}`, summary: '', body: '', tags: [],
    canon: { status: 'proposed' }, media: [], position: { x: 0, y: 0 }, regionId: null, layer: 0,
    createdBy: { harness: 'claude', at: T0 }, updatedAt: T0, version: 2, meta: {},
  };
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    if (error instanceof CanonProposalError) return error.code;
    throw error;
  }
  return undefined;
}

describe('canonProposalRequestFromRow', () => {
  it('maps an L2 row to a canon proposal request', () => {
    expect(canonProposalRequestFromRow(row, { worldId: 'testland' })).toEqual({
      worldId: 'testland',
      title: 'The Glass Orchard',
      nodeIds: ['n_orchard', 'n_keeper'],
      rationale: 'The orchard and its keeper recur across three drafts.',
      proposer: { harness: 'claude', actor: 'svc-claude' },
      date: '2026-11-25',
    });
  });

  it('refuses a row that is not open or already has a PR', () => {
    expect(codeOf(() => canonProposalRequestFromRow({ ...row, status: 'merged' }, { worldId: 'testland' }))).toBe('NOT_OPEN');
    expect(codeOf(() => canonProposalRequestFromRow({ ...row, status: 'closed' }, { worldId: 'testland' }))).toBe('NOT_OPEN');
    expect(codeOf(() => canonProposalRequestFromRow({ ...row, prUrl: 'https://github.com/o/r/pull/1' }, { worldId: 'testland' }))).toBe('NOT_OPEN');
  });

  it('leaves out a null actor', () => {
    expect(canonProposalRequestFromRow({ ...row, actor: null }, { worldId: 'testland' }).proposer).toEqual({ harness: 'claude' });
  });

  it('uses the UTC date of createdAt, offsets included', () => {
    expect(canonProposalRequestFromRow({ ...row, createdAt: '2026-11-25T23:30:00-05:00' }, { worldId: 'testland' }).date).toBe('2026-11-26');
    expect(canonProposalRequestFromRow({ ...row, createdAt: '2026-01-01T00:00:00.000Z' }, { worldId: 'testland' }).date).toBe('2026-01-01');
  });

  it('feeds buildCanonProposal', () => {
    const request = canonProposalRequestFromRow(row, { worldId: 'testland' });
    const built = buildCanonProposal(request, [node('n_orchard'), node('n_keeper')]);
    expect(built.path).toBe('.arcanea/lore/proposals/2026-11-25-the-glass-orchard.md');
    expect(built.branch).toBe('canon/the-glass-orchard');
  });

  it('refuses rows that name edges instead of dropping them', () => {
    let caught: unknown;
    try {
      canonProposalRequestFromRow({ ...row, edgeIds: ['e_1', 'e_2'] }, { worldId: 'testland' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CanonProposalError);
    expect(caught).toMatchObject({ code: 'UNSUPPORTED_TARGET' });
    expect((caught as Error).message).toContain('2 edges');
    expect(codeOf(() => canonProposalRequestFromRow({ ...row, nodeIds: [], edgeIds: ['e_1'] }, { worldId: 'testland' }))).toBe('UNSUPPORTED_TARGET');
  });

  it('keeps our rationale limit (4000), above L2 (2000)', () => {
    expect(canonProposalRequestFromRow({ ...row, rationale: 'r'.repeat(4000) }, { worldId: 'testland' }).rationale).toHaveLength(4000);
    expect(codeOf(() => canonProposalRequestFromRow({ ...row, rationale: 'r'.repeat(4001) }, { worldId: 'testland' }))).toBe('INVALID_REQUEST');
  });

  it('strips unknown row keys', () => {
    expect(canonProposalRequestFromRow({ ...row, futureField: 1 }, { worldId: 'testland' })).not.toHaveProperty('futureField');
  });

  it.each([
    ['a missing field', (() => { const { title: _t, ...rest } = row; return rest; })()],
    ['createdAt that is not a datetime', { ...row, createdAt: '2026-11-25' }],
    ['a non-array nodeIds', { ...row, nodeIds: 'n_orchard' }],
    ['a negative worldVersion', { ...row, worldVersion: -1 }],
    ['not an object', null],
  ])('refuses a row with %s', (_label, bad) => {
    expect(codeOf(() => canonProposalRequestFromRow(bad, { worldId: 'testland' }))).toBe('INVALID_REQUEST');
  });

  it.each([
    ['an invalid harness', { ...row, harness: 'Claude Code' }],
    ['an empty actor', { ...row, actor: '' }],
    ['no node ids', { ...row, nodeIds: [] }],
    ['duplicate node ids', { ...row, nodeIds: ['n_a', 'n_a'] }],
    ['more than 100 node ids (L2 allows 100 targets)', { ...row, nodeIds: Array.from({ length: 101 }, (_, i) => `n_${i}`) }],
    ['a blank title', { ...row, title: '   ' }],
    ['a blank rationale', { ...row, rationale: ' ' }],
  ])('refuses a row that makes an invalid request: %s', (_label, bad) => {
    expect(codeOf(() => canonProposalRequestFromRow(bad, { worldId: 'testland' }))).toBe('INVALID_REQUEST');
  });

  it('refuses an invalid worldId', () => {
    expect(codeOf(() => canonProposalRequestFromRow(row, { worldId: '../etc' }))).toBe('INVALID_REQUEST');
    expect(codeOf(() => canonProposalRequestFromRow(row, undefined as never))).toBe('INVALID_REQUEST');
  });
});
