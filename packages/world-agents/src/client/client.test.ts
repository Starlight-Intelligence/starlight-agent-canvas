import type { ImportLexicon } from '@starlight-agent-canvas/world';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { z } from 'zod';
import {
  createWorldClient,
  importLexiconSchema,
  WORLD_TOOLS,
  WORLD_TOOL_NAMES,
  WorldClientValidationError,
  WorldToolError,
  type WorldToolName,
  type WorldTransport,
} from './index.js';

/*
 * Payloads below copy the shapes the L2 server (apps/world-edge at 161c054)
 * produces: getWorldInfo, RegionResult (cluster, card, full), searchWorld,
 * WriteResult, proposeCanon (+ proposalId), layoutRegion (+ moved), and the
 * import_whiteboard results in mcp.ts.
 */

const AT = '2026-11-25T00:00:00.000Z';
const actor = { harness: 'claude', actor: 'svc-claude', at: AT };

const node = {
  id: 'n_arion',
  worldId: 'arcanea',
  kind: 'character',
  title: 'Arion',
  summary: '',
  body: '',
  tags: [],
  canon: { status: 'draft' },
  media: [],
  position: { x: 10, y: 20 },
  regionId: null,
  layer: 0,
  createdBy: actor,
  updatedAt: AT,
  version: 2,
  meta: {},
};

const edge = {
  id: 'e_1',
  worldId: 'arcanea',
  from: 'n_arion',
  to: 'n_gate',
  relation: 'appears-in',
  canon: { status: 'draft' },
  createdBy: actor,
  updatedAt: AT,
  version: 1,
  meta: {},
};

/** NodeCard from region.ts toCard. */
const card = {
  id: 'n_arion',
  kind: 'character',
  title: 'Arion',
  tags: ['ferryman'],
  position: { x: 10, y: 20 },
  regionId: 'r_core',
  layer: 0,
  canon: { status: 'draft' },
  version: 2,
  thumbnail: { url: 'https://example.com/arion.png', alt: '', role: 'portrait' },
};

/** EdgeSummary from region.ts projectEdges. */
const edgeSummary = { id: 'e_1', from: 'n_arion', to: 'n_gate', relation: 'appears-in', canon: { status: 'draft' }, version: 1 };

const region = { id: 'r_core', title: 'Core', bounds: { x: 0, y: 0, w: 4096, h: 4096 } };
const world = { id: 'arcanea', title: 'Arcanea', summary: '', version: 7, regions: [region], updatedAt: AT };

const regionBase = { ok: true, version: 7, bounds: region.bounds, regions: [region], truncated: false };

/** WriteResult success from world-agent.ts. */
function write(overrides: Record<string, unknown> = {}) {
  return { ok: true, version: 8, seq: 12, nodes: [node], edges: [], removedNodes: [], removedEdges: [], proposals: [], ...overrides };
}

const proposal = { targetType: 'node', id: 'n_arion', title: 'Arion', version: 3, note: 'Recurring ferryman.', proposedBy: actor };

const report = {
  source: { title: 'Board' },
  elementsIn: 1,
  elementsByType: { text: 1 },
  nodesOut: 1,
  nodesByKind: { concept: 1 },
  edgesOut: 0,
  edgesByRelation: {},
  regionsOut: 1,
  dispositions: { node: 1, merged: 0, expanded: 0, edge: 0, region: 0, skipped: 0 },
  needsReupload: 0,
  skipped: [],
  truncated: [],
  warnings: [],
};

const whiteboard = { title: 'Board', elements: { a: { type: 'text' as const, text: 'Hello' } } };

interface Case {
  name: string;
  tool: WorldToolName;
  method: string;
  input: Record<string, unknown>;
  badInput: Record<string, unknown>;
  output: unknown;
  badOutput: unknown;
}

const cases: Case[] = [
  {
    name: 'get_world',
    tool: 'get_world',
    method: 'getWorld',
    input: { worldId: 'arcanea' },
    badInput: { worldId: 'not a world id' },
    output: { world, counts: { nodes: 3, edges: 1, nodesByKind: { character: 2, place: 1 }, edgesByRelation: { 'appears-in': 1 } }, openProposals: 1 },
    badOutput: { world, counts: { nodes: 3, edges: 1, nodesByKind: {}, edgesByRelation: {} } },
  },
  {
    name: 'get_region (cluster)',
    tool: 'get_region',
    method: 'getRegion',
    input: { worldId: 'arcanea', bounds: { x: 0, y: 0, w: 4096, h: 4096 }, level: 'cluster' },
    badInput: { worldId: 'arcanea', level: 'cluster' },
    output: { ...regionBase, level: 'cluster', clusters: [{ tile: '0:0', count: 3, byKind: { place: 2, character: 1 }, center: { x: 10.5, y: 20 } }], nodes: [], edges: [] },
    badOutput: { ...regionBase, level: 'cluster', clusters: [], nodes: [card], edges: [] },
  },
  {
    name: 'get_region (card)',
    tool: 'get_region',
    method: 'getRegion',
    input: { worldId: 'arcanea', regionId: 'r_core', zoom: 0.8, kinds: ['character'], limit: 100 },
    badInput: { worldId: 'arcanea', regionId: 'r_core', limit: 5001 },
    output: { ...regionBase, level: 'card', clusters: [], nodes: [card], edges: [edgeSummary] },
    badOutput: { ...regionBase, level: 'card', clusters: [], nodes: [{ ...card, version: undefined }], edges: [] },
  },
  {
    name: 'get_region (full)',
    tool: 'get_region',
    method: 'getRegion',
    input: { worldId: 'arcanea', regionId: 'r_core', bounds: { x: 0, y: 0, w: 100, h: 100 }, level: 'full' },
    badInput: { worldId: 'arcanea', regionId: 'r_core', kinds: ['dragon'] },
    output: { ...regionBase, level: 'full', clusters: [], nodes: [node], edges: [edge], truncated: true },
    badOutput: { ...regionBase, level: 'full', clusters: [], nodes: [card], edges: [] },
  },
  {
    name: 'search',
    tool: 'search',
    method: 'search',
    input: { worldId: 'arcanea', query: 'arion', kinds: ['character'], limit: 50 },
    badInput: { worldId: 'arcanea', query: 'arion', limit: 51 },
    output: { mode: 'semantic', hits: [{ id: 'n_arion', kind: 'character', title: 'Arion', summary: '', position: { x: 1, y: 2 }, regionId: null, score: 0.91 }] },
    badOutput: { mode: 'fts', hits: [] },
  },
  {
    name: 'add_node',
    tool: 'add_node',
    method: 'addNode',
    input: { worldId: 'arcanea', node: { kind: 'character', title: 'Arion', position: { x: 10, y: 20 } } },
    badInput: { worldId: 'arcanea', node: { kind: 'character', title: 'Arion', position: { x: 10, y: 20 }, version: 9 } },
    output: write(),
    badOutput: write({ seq: undefined }),
  },
  {
    name: 'update_node',
    tool: 'update_node',
    method: 'updateNode',
    input: { worldId: 'arcanea', id: 'n_arion', baseVersion: 1, patch: { summary: 'The ferryman.' } },
    badInput: { worldId: 'arcanea', id: 'n_arion', baseVersion: 1, patch: {} },
    output: write(),
    badOutput: write({ ok: false }),
  },
  {
    name: 'link',
    tool: 'link',
    method: 'link',
    input: { worldId: 'arcanea', from: 'n_arion', to: 'n_gate', relation: 'appears-in', label: 'opens' },
    badInput: { worldId: 'arcanea', from: 'n_arion', to: 'n_gate', relation: 'loves' },
    output: write({ nodes: [], edges: [edge] }),
    badOutput: write({ nodes: [], edges: [{ ...edge, to: 'n_arion' }] }),
  },
  {
    name: 'move',
    tool: 'move',
    method: 'move',
    input: { worldId: 'arcanea', moves: [{ id: 'n_arion', baseVersion: 1, position: { x: 50, y: 60 }, regionId: 'r_core' }] },
    badInput: { worldId: 'arcanea', moves: [] },
    output: write(),
    badOutput: write({ nodes: node }),
  },
  {
    name: 'propose_canon',
    tool: 'propose_canon',
    method: 'proposeCanon',
    input: { worldId: 'arcanea', title: 'Arion the ferryman', targets: [{ type: 'node', id: 'n_arion', baseVersion: 2 }], rationale: 'Recurring ferryman.' },
    badInput: { worldId: 'arcanea', title: 'Arion', targets: [], rationale: 'x' },
    output: write({ nodes: [{ ...node, version: 3, canon: { status: 'proposed' } }], proposals: [proposal], proposalId: 'cp_canon_0833jf26tji' }),
    badOutput: write({ proposals: [proposal] }),
  },
  {
    name: 'layout_region',
    tool: 'layout_region',
    method: 'layoutRegion',
    input: { worldId: 'arcanea', regionId: 'r_core', strategy: 'grid' },
    badInput: { worldId: 'arcanea', regionId: 'r_core', strategy: 'spiral' },
    output: write({ moved: 1 }),
    badOutput: write({ moved: '1' }),
  },
  {
    name: 'import_whiteboard',
    tool: 'import_whiteboard',
    method: 'importWhiteboard',
    input: { worldId: 'board', whiteboard, lexicon: { kinds: { Arion: 'character' }, tags: { Arion: ['ferryman'] } }, title: 'Board' },
    badInput: { whiteboard },
    output: { ok: true, version: 1, seq: 1, report },
    badOutput: { ok: true, report },
  },
  {
    name: 'import_whiteboard (dry run)',
    tool: 'import_whiteboard',
    method: 'importWhiteboard',
    input: { worldId: 'board', whiteboard, dryRun: true },
    badInput: { worldId: 'board', whiteboard, dryRun: 'yes' },
    output: { ok: true, dryRun: true, report },
    badOutput: { ok: true, dryRun: false, report },
  },
];

function mockTransport(payload: unknown) {
  const callTool = vi.fn(async (_name: string, _args: Record<string, unknown>) => payload);
  return { transport: { callTool } satisfies WorldTransport, callTool };
}

type AnyMethod = (args: Record<string, unknown>) => Promise<unknown>;
function method(client: object, name: string): AnyMethod {
  return (client as Record<string, AnyMethod>)[name]!;
}

async function rejectsInput(name: string, args: Record<string, unknown>, worldId = 'arcanea') {
  const { transport, callTool } = mockTransport({});
  const client = createWorldClient({ transport, worldId });
  const error = await method(client, name)(args).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(WorldClientValidationError);
  expect((error as WorldClientValidationError).direction).toBe('input');
  expect(callTool).not.toHaveBeenCalled();
}

async function acceptsInput(name: string, args: Record<string, unknown>) {
  const { transport, callTool } = mockTransport({});
  const client = createWorldClient({ transport, worldId: 'arcanea' });
  // The mock output is empty, so the call fails on output; the input got through.
  await method(client, name)(args).catch(() => undefined);
  expect(callTool).toHaveBeenCalledTimes(1);
}

describe('WORLD_TOOLS', () => {
  it('lists exactly the ten spec tools and nothing destructive', () => {
    expect([...WORLD_TOOL_NAMES].sort()).toEqual([
      'add_node', 'get_region', 'get_world', 'import_whiteboard', 'layout_region',
      'link', 'move', 'propose_canon', 'search', 'update_node',
    ]);
    const client = createWorldClient({ transport: mockTransport({}).transport });
    for (const forbidden of ['removeNode', 'removeEdge', 'promoteToCanon', 'remove_node', 'remove_edge', 'promote_to_canon']) {
      expect(forbidden in client).toBe(false);
      expect(forbidden in WORLD_TOOLS).toBe(false);
    }
  });
});

describe.each(cases)('$name', (c) => {
  it('round-trips an L2-shaped payload', async () => {
    const { transport, callTool } = mockTransport(c.output);
    const client = createWorldClient({ transport });
    const result = await method(client, c.method)(c.input);
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(callTool.mock.calls[0]![0]).toBe(c.tool);
    expect(callTool.mock.calls[0]![1]).toEqual(c.input);
    expect(result).toEqual(c.output);
  });

  it('rejects invalid input without calling the transport', async () => {
    const { transport, callTool } = mockTransport(c.output);
    const client = createWorldClient({ transport });
    const error = await method(client, c.method)(c.badInput).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WorldClientValidationError);
    expect((error as WorldClientValidationError).direction).toBe('input');
    expect((error as WorldClientValidationError).tool).toBe(c.tool);
    expect((error as WorldClientValidationError).issues.length).toBeGreaterThan(0);
    expect(callTool).not.toHaveBeenCalled();
  });

  it('rejects invalid output', async () => {
    const { transport, callTool } = mockTransport(c.badOutput);
    const client = createWorldClient({ transport });
    const error = await method(client, c.method)(c.input).catch((e: unknown) => e);
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(error).toBeInstanceOf(WorldClientValidationError);
    expect((error as WorldClientValidationError).direction).toBe('output');
  });

  it('rejects unknown top-level input keys', async () => {
    const { transport, callTool } = mockTransport(c.output);
    const client = createWorldClient({ transport });
    await expect(method(client, c.method)({ ...c.input, extra: true })).rejects.toBeInstanceOf(WorldClientValidationError);
    expect(callTool).not.toHaveBeenCalled();
  });
});

describe('inputs match L2', () => {
  it('get_region takes regionId, bounds or both, plus level, zoom, kinds and limit up to 5000', async () => {
    await acceptsInput('getRegion', { regionId: 'r_core' });
    await acceptsInput('getRegion', { bounds: { x: 0, y: 0, w: 1, h: 1 } });
    await acceptsInput('getRegion', { regionId: 'r_core', bounds: { x: 0, y: 0, w: 1, h: 1 }, level: 'card', zoom: 2, kinds: [], limit: 5000 });
    await rejectsInput('getRegion', {});
    await rejectsInput('getRegion', { regionId: 'r_core', limit: 0 });
    await rejectsInput('getRegion', { regionId: 'r_core', zoom: 0 });
    await rejectsInput('getRegion', { regionId: 'r_core', zoom: Number.POSITIVE_INFINITY });
    await rejectsInput('getRegion', { bounds: { x: 0, y: 0, w: 0, h: 1 } });
  });

  it('search takes limit 1..50 and any kinds list, including empty', async () => {
    await acceptsInput('search', { query: 'x', limit: 1 });
    await acceptsInput('search', { query: 'x', limit: 50, kinds: [] });
    for (const limit of [0, 51, 2.5]) await rejectsInput('search', { query: 'x', limit });
    await rejectsInput('search', { query: '' });
    await rejectsInput('search', { query: 'x'.repeat(501) });
    await rejectsInput('search', { query: 'x', kinds: ['dragon'] });
  });

  it('propose_canon takes title, 1..100 targets with baseVersion, and a rationale up to 2000', async () => {
    const target = { type: 'node', id: 'n_a', baseVersion: 1 };
    const base = { title: 'T', targets: [target], rationale: 'R' };
    await acceptsInput('proposeCanon', base);
    await acceptsInput('proposeCanon', { ...base, targets: Array.from({ length: 100 }, (_, i) => ({ ...target, id: `n_${i}` })) });
    await acceptsInput('proposeCanon', { ...base, rationale: 'r'.repeat(2000), targets: [{ type: 'edge', id: 'e_1', baseVersion: 3 }] });
    await rejectsInput('proposeCanon', { ...base, targets: Array.from({ length: 101 }, (_, i) => ({ ...target, id: `n_${i}` })) });
    await rejectsInput('proposeCanon', { ...base, rationale: 'r'.repeat(2001) });
    await rejectsInput('proposeCanon', { ...base, rationale: '' });
    await rejectsInput('proposeCanon', { ...base, title: '' });
    await rejectsInput('proposeCanon', { ...base, title: 't'.repeat(301) });
    for (const baseVersion of [0, 1.5, undefined]) await rejectsInput('proposeCanon', { ...base, targets: [{ ...target, baseVersion }] });
    await rejectsInput('proposeCanon', { ...base, targets: [{ ...target, type: 'region' }] });
    // The old single-target shape is gone.
    await rejectsInput('proposeCanon', { target: { type: 'node', id: 'n_a' }, baseVersion: 1, note: 'why' });
  });

  it('import_whiteboard needs worldId and takes lexicon, title and dryRun', async () => {
    await acceptsInput('importWhiteboard', { whiteboard, title: 'Board', dryRun: false });
    await rejectsInput('importWhiteboard', { whiteboard, title: '' });
    await rejectsInput('importWhiteboard', { whiteboard, dryRun: 1 });
    // With no default world, a missing worldId fails locally.
    const { transport, callTool } = mockTransport({});
    await expect(createWorldClient({ transport }).importWhiteboard({ whiteboard } as never)).rejects.toBeInstanceOf(WorldClientValidationError);
    expect(callTool).not.toHaveBeenCalled();
  });

  it('import_whiteboard lexicon matches L2 (L1 ImportLexicon with bounded tags) and is strict', async () => {
    expectTypeOf<z.output<typeof importLexiconSchema>>().toEqualTypeOf<ImportLexicon>();
    for (const lexicon of [
      { kinds: { Nero: 'deity' } },
      { tags: { Nero: 'god' } },
      { tags: { Nero: [''] } },
      { tags: { Nero: ['t'.repeat(65)] } },
      { kinds: {}, extra: true },
      { aliases: { Nero: 'Nero the First' } },
    ]) {
      await rejectsInput('importWhiteboard', { whiteboard, lexicon });
    }
    await acceptsInput('importWhiteboard', { whiteboard, lexicon: { kinds: { Nero: 'god' }, tags: { Nero: ['first', 't'.repeat(64)] } } });
  });

  it('link rejects a self edge locally', async () => {
    await rejectsInput('link', { from: 'n_a', to: 'n_a', relation: 'rules' });
  });

  it('update_node and move reject baseVersion 0, fractional or missing', async () => {
    for (const baseVersion of [0, 1.5, undefined]) {
      await rejectsInput('updateNode', { id: 'n_a', baseVersion, patch: { title: 'A' } });
      await rejectsInput('move', { moves: [{ id: 'n_a', baseVersion, position: { x: 0, y: 0 } }] });
    }
  });

  it('sends the parsed input (defaults applied, non-strict nested keys stripped), not the raw input', async () => {
    const { transport, callTool } = mockTransport(write());
    const client = createWorldClient({ transport, worldId: 'arcanea' });
    const raw = {
      node: {
        kind: 'image' as const,
        title: 'Plate',
        position: { x: 1, y: 2, z: 3 } as { x: number; y: number },
        media: [{ url: 'https://example.com/plate.png', role: 'plate' as const }],
      },
    };
    await client.addNode(raw);
    const sent = callTool.mock.calls[0]![1];
    expect(sent).toEqual({
      worldId: 'arcanea',
      node: { kind: 'image', title: 'Plate', position: { x: 1, y: 2 }, media: [{ url: 'https://example.com/plate.png', role: 'plate', alt: '' }] },
    });
    expect(sent).not.toBe(raw);
  });
});

describe('outputs match L2', () => {
  it('get_world counts accept kinds and relations the client does not know', async () => {
    const { transport } = mockTransport({ world, counts: { nodes: 1, edges: 1, nodesByKind: { dragon: 1 }, edgesByRelation: { haunts: 1 } }, openProposals: 0 });
    const result = await createWorldClient({ transport, worldId: 'arcanea' }).getWorld({});
    expect(result.counts.nodesByKind).toEqual({ dragon: 1 });
    expect(result.counts.edgesByRelation).toEqual({ haunts: 1 });
  });

  it('search hits keep kinds as plain strings, as the server types them', async () => {
    const hit = { id: 'n_x', kind: 'dragon', title: 'X', summary: 's', position: { x: 0, y: 0 }, regionId: 'r_1' };
    const { transport } = mockTransport({ mode: 'd1-like', hits: [hit] });
    const result = await createWorldClient({ transport, worldId: 'arcanea' }).search({ query: 'x' });
    expect(result.hits).toEqual([hit]);
  });

  it('get_region results narrow by level', async () => {
    const { transport } = mockTransport({ ...regionBase, level: 'card', clusters: [], nodes: [card], edges: [edgeSummary] });
    const result = await createWorldClient({ transport, worldId: 'arcanea' }).getRegion({ regionId: 'r_core' });
    if (result.level !== 'card') throw new Error('expected card level');
    expectTypeOf(result.nodes[0]!).not.toHaveProperty('body');
    expect(result.nodes[0]!.version).toBe(2);
  });

  it('rejects a get_region result without truncated', async () => {
    const { truncated: _omit, ...withoutTruncated } = { ...regionBase, level: 'card' as const, clusters: [], nodes: [card], edges: [edgeSummary] };
    const { transport } = mockTransport(withoutTruncated);
    await expect(createWorldClient({ transport, worldId: 'arcanea' }).getRegion({ regionId: 'r_core' })).rejects.toBeInstanceOf(WorldClientValidationError);
  });

  it('accepts the layout_region no-op result (seq 0, moved 0)', async () => {
    const noop = { ok: true, version: 7, seq: 0, nodes: [], edges: [], removedNodes: [], removedEdges: [], proposals: [], moved: 0 };
    const { transport } = mockTransport(noop);
    await expect(createWorldClient({ transport, worldId: 'arcanea' }).layoutRegion({ regionId: 'r_core', strategy: 'force' })).resolves.toEqual(noop);
  });

  it('strips extra server fields instead of failing', async () => {
    const { transport } = mockTransport({ ...write({ nodes: [{ ...node, futureField: 1 }] }), serverHint: 'x' });
    const result = await createWorldClient({ transport, worldId: 'arcanea' }).updateNode({ id: 'n_arion', baseVersion: 1, patch: { title: 'Arion' } });
    expect(result).not.toHaveProperty('serverHint');
    expect(result.nodes[0]).not.toHaveProperty('futureField');
    expect(result.version).toBe(8);
  });
});

describe('import_whiteboard result checks', () => {
  const written = { ok: true, version: 1, seq: 1, report };
  const dry = { ok: true, dryRun: true, report };

  it('refuses a write result for a dry-run request', async () => {
    const { transport } = mockTransport(written);
    await expect(createWorldClient({ transport, worldId: 'board' }).importWhiteboard({ whiteboard, dryRun: true }))
      .rejects.toMatchObject({ name: 'WorldClientValidationError', direction: 'output', message: expect.stringContaining('dry run') });
  });

  it.each([[undefined], [false]])('refuses a dry-run result for a write request (dryRun %s)', async (dryRun) => {
    const { transport } = mockTransport(dry);
    await expect(createWorldClient({ transport, worldId: 'board' }).importWhiteboard({ whiteboard, ...(dryRun === undefined ? {} : { dryRun }) }))
      .rejects.toMatchObject({ name: 'WorldClientValidationError', direction: 'output', message: expect.stringContaining('nothing was imported') });
  });

  it('refuses a result that claims both a dry run and a write', async () => {
    const { transport } = mockTransport({ ...written, dryRun: true });
    await expect(createWorldClient({ transport, worldId: 'board' }).importWhiteboard({ whiteboard, dryRun: true }))
      .rejects.toBeInstanceOf(WorldClientValidationError);
  });

  it.each([
    ['any object', { anything: 1 }],
    ['an empty object', {}],
    ['a report missing dispositions', (() => { const { dispositions: _d, ...rest } = report; return rest; })()],
    ['a report with a string count', { ...report, nodesOut: '1' }],
    ['a report with a negative count', { ...report, elementsIn: -1 }],
    ['a report with a bad truncation field', { ...report, truncated: [{ nodeId: 'n', elementIds: [], field: 'canon', originalLength: 1, keptLength: 0, fullTextIn: null }] }],
  ])('refuses %s as the report', async (_label, bad) => {
    for (const [payload, dryRun] of [[{ ...written, report: bad }, false], [{ ...dry, report: bad }, true]] as const) {
      const { transport } = mockTransport(payload);
      await expect(createWorldClient({ transport, worldId: 'board' }).importWhiteboard({ whiteboard, dryRun }))
        .rejects.toMatchObject({ name: 'WorldClientValidationError', direction: 'output' });
    }
  });

  it('accepts a full L1 ImportReport', async () => {
    const full = { ...report, source: { title: 'Board', format: 'claude.whiteboard', exportedAt: '2026-11-25T00:00:00Z' }, skipped: [{ elementId: 'e1', reason: 'empty' }], truncated: [{ nodeId: 'n1', elementIds: ['e2'], field: 'title', originalLength: 400, keptLength: 300, fullTextIn: 'body' }], warnings: ['w'] };
    const { transport } = mockTransport({ ...written, report: full });
    await expect(createWorldClient({ transport, worldId: 'board' }).importWhiteboard({ whiteboard })).resolves.toMatchObject({ version: 1, report: full });
  });
});

describe('canon gate', () => {
  it('add_node cannot carry canon status "proposed" either (propose_canon records the proposal)', async () => {
    await rejectsInput('addNode', {
      node: { kind: 'god', title: 'Nero', position: { x: 0, y: 0 }, canon: { status: 'proposed' } },
    });
  });

  it('add_node cannot carry any canon field, even draft', async () => {
    await rejectsInput('addNode', {
      node: { kind: 'god', title: 'Nero', position: { x: 0, y: 0 }, canon: { status: 'draft' } },
    });
  });

  it('add_node cannot carry canon status "canon"', async () => {
    await rejectsInput('addNode', {
      node: { kind: 'god', title: 'Nero', position: { x: 0, y: 0 }, canon: { status: 'canon', ref: 'https://example.com/pr/1' } },
    });
  });

  it('update_node patch cannot carry canon, version or createdBy', async () => {
    await rejectsInput('updateNode', { id: 'n_arion', baseVersion: 1, patch: { title: 'Arion', canon: { status: 'canon', ref: 'https://example.com/pr/1' } } });
    await rejectsInput('updateNode', { id: 'n_arion', baseVersion: 1, patch: { version: 99 } });
    await rejectsInput('updateNode', { id: 'n_arion', baseVersion: 1, patch: { createdBy: actor } });
  });

  it('link and move cannot carry canon', async () => {
    await rejectsInput('link', { from: 'n_a', to: 'n_b', relation: 'rules', canon: { status: 'canon' } });
    await rejectsInput('move', { moves: [{ id: 'n_a', baseVersion: 1, position: { x: 0, y: 0 }, canon: { status: 'canon' } }] });
  });

  it('propose_canon cannot carry a status or ref, at the top or on a target', async () => {
    const base = { title: 'T', targets: [{ type: 'node', id: 'n_arion', baseVersion: 2 }], rationale: 'Please' };
    await rejectsInput('proposeCanon', { ...base, ref: 'https://github.com/x/y/pull/1' });
    await rejectsInput('proposeCanon', { ...base, status: 'canon' });
    await rejectsInput('proposeCanon', { ...base, targets: [{ ...base.targets[0], status: 'canon' }] });
    await rejectsInput('proposeCanon', { ...base, targets: [{ ...base.targets[0], ref: 'https://github.com/x/y/pull/1' }] });
  });
});

describe('default world', () => {
  it('fills worldId for every tool, import_whiteboard included, and lets an explicit one win', async () => {
    const { transport, callTool } = mockTransport({ world, counts: { nodes: 0, edges: 0, nodesByKind: {}, edgesByRelation: {} }, openProposals: 0 });
    const client = createWorldClient({ transport, worldId: 'arcanea' });
    expect(client.worldId).toBe('arcanea');
    await client.getWorld({});
    await client.getWorld({ worldId: 'other' });
    await client.importWhiteboard({ whiteboard, dryRun: true }).catch(() => undefined);
    expect(callTool.mock.calls.map((call) => call[1].worldId)).toEqual(['arcanea', 'other', 'arcanea']);
  });

  it('without a default, a missing worldId fails locally', async () => {
    const { transport, callTool } = mockTransport({});
    const client = createWorldClient({ transport });
    await expect(method(client, 'getWorld')({})).rejects.toBeInstanceOf(WorldClientValidationError);
    expect(callTool).not.toHaveBeenCalled();
  });
});

describe('tool errors', () => {
  it('passes STALE_VERSION through with its details', async () => {
    const stale = new WorldToolError('update_node', {
      code: 'STALE_VERSION', message: 'node n_arion is at version 3', opIndex: 0, id: 'n_arion', expectedVersion: 2, actualVersion: 3, worldVersion: 9,
    });
    const transport: WorldTransport = { callTool: vi.fn(async () => { throw stale; }) };
    const client = createWorldClient({ transport, worldId: 'arcanea' });
    const error = await client.updateNode({ id: 'n_arion', baseVersion: 2, patch: { title: 'A' } }).catch((e: unknown) => e);
    expect(error).toBe(stale);
    expect((error as WorldToolError).isStale).toBe(true);
    expect((error as WorldToolError).expectedVersion).toBe(2);
    expect((error as WorldToolError).actualVersion).toBe(3);
    expect((error as WorldToolError).worldVersion).toBe(9);
  });
});
