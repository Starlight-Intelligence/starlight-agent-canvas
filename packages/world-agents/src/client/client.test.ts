import type { ImportLexicon } from '@starlight-agent-canvas/world';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { z } from 'zod';
import {
  importLexiconSchema,
  createWorldClient,
  WORLD_TOOLS,
  WORLD_TOOL_NAMES,
  WorldClientValidationError,
  WorldToolError,
  type WorldToolName,
  type WorldTransport,
} from './index.js';

const AT = '2026-11-25T00:00:00.000Z';
const actor = { harness: 'claude', at: AT };

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

const world = { id: 'arcanea', title: 'Arcanea', summary: '', version: 7, regions: [], updatedAt: AT };

interface Case {
  tool: WorldToolName;
  method: string;
  input: Record<string, unknown>;
  badInput: Record<string, unknown>;
  output: Record<string, unknown>;
  badOutput: unknown;
}

const cases: Case[] = [
  {
    tool: 'get_world',
    method: 'getWorld',
    input: { worldId: 'arcanea' },
    badInput: { worldId: 'not a world id' },
    output: { world, counts: { nodes: { character: 3, gate: 10 }, edges: { rules: 10 } }, worldVersion: 7 },
    badOutput: { world, counts: { nodes: { dragon: 1 }, edges: {} }, worldVersion: 7 },
  },
  {
    tool: 'get_region',
    method: 'getRegion',
    input: { worldId: 'arcanea', bounds: { x: 0, y: 0, w: 4096, h: 4096 }, level: 'cluster' },
    badInput: { worldId: 'arcanea', regionId: 'r_core', bounds: { x: 0, y: 0, w: 10, h: 10 } },
    output: { level: 'cluster', nodes: [node], edges: [edge], clusters: [{ tileKey: '0:-1', counts: { place: 4 } }], worldVersion: 7 },
    badOutput: { level: 'zoomed', nodes: [], edges: [], worldVersion: 7 },
  },
  {
    tool: 'search',
    method: 'search',
    input: { worldId: 'arcanea', query: 'arion', kinds: ['character'], limit: 5 },
    badInput: { worldId: 'arcanea', query: '' },
    output: { results: [{ id: 'n_arion', kind: 'character', title: 'Arion', summary: '', position: { x: 1, y: 2 }, regionId: null, score: 0.9 }], worldVersion: 7 },
    badOutput: { results: [{ id: 'n_arion', kind: 'character', title: 'Arion', summary: '', position: { x: 1, y: 2 } }], worldVersion: 7 },
  },
  {
    tool: 'add_node',
    method: 'addNode',
    input: { worldId: 'arcanea', node: { kind: 'character', title: 'Arion', position: { x: 10, y: 20 } } },
    badInput: { worldId: 'arcanea', node: { kind: 'character', title: 'Arion', position: { x: 10, y: 20 }, version: 9 } },
    output: { node, worldVersion: 8 },
    badOutput: { node: { ...node, version: 0 }, worldVersion: 8 },
  },
  {
    tool: 'update_node',
    method: 'updateNode',
    input: { worldId: 'arcanea', id: 'n_arion', baseVersion: 1, patch: { summary: 'The ferryman.' } },
    badInput: { worldId: 'arcanea', id: 'n_arion', baseVersion: 1, patch: {} },
    output: { node, worldVersion: 8 },
    badOutput: { node, worldVersion: -1 },
  },
  {
    tool: 'link',
    method: 'link',
    input: { worldId: 'arcanea', from: 'n_arion', to: 'n_gate', relation: 'appears-in', label: 'opens' },
    badInput: { worldId: 'arcanea', from: 'n_arion', to: 'n_gate', relation: 'loves' },
    output: { edge, worldVersion: 8 },
    badOutput: { edge: { ...edge, to: 'n_arion' }, worldVersion: 8 },
  },
  {
    tool: 'move',
    method: 'move',
    input: { worldId: 'arcanea', moves: [{ id: 'n_arion', baseVersion: 1, position: { x: 50, y: 60 }, regionId: 'r_core' }] },
    badInput: { worldId: 'arcanea', moves: [] },
    output: { nodes: [node], worldVersion: 8 },
    badOutput: { nodes: node, worldVersion: 8 },
  },
  {
    tool: 'propose_canon',
    method: 'proposeCanon',
    input: { worldId: 'arcanea', target: { type: 'node', id: 'n_arion' }, baseVersion: 2, note: 'Matches the Ten Gates draft.' },
    badInput: { worldId: 'arcanea', target: { type: 'region', id: 'n_arion' }, baseVersion: 2, note: 'x' },
    output: {
      proposal: { targetType: 'node', id: 'n_arion', title: 'Arion', version: 3, note: 'Matches the Ten Gates draft.', proposedBy: actor },
      prUrl: 'https://github.com/frankxai/arcanea-ai-app/pull/1',
      worldVersion: 8,
    },
    badOutput: {
      proposal: { targetType: 'node', id: 'n_arion', title: 'Arion', version: 3, proposedBy: actor },
      prUrl: 'http://github.com/frankxai/arcanea-ai-app/pull/1',
      worldVersion: 8,
    },
  },
  {
    tool: 'layout_region',
    method: 'layoutRegion',
    input: { worldId: 'arcanea', regionId: 'r_core', strategy: 'grid' },
    badInput: { worldId: 'arcanea', regionId: 'r_core', strategy: 'spiral' },
    output: { moved: [node], worldVersion: 8 },
    badOutput: { moved: [{ ...node, worldId: '' }], worldVersion: 8 },
  },
  {
    tool: 'import_whiteboard',
    method: 'importWhiteboard',
    input: { whiteboard: { title: 'Board', elements: { a: { type: 'text', text: 'Hello' } } }, lexicon: { kinds: { Arion: 'character' } } },
    badInput: { whiteboard: { title: 'Board' } },
    output: { report: { nodesOut: 1, warnings: [] }, worldId: 'board', worldVersion: 1, branch: 'import/board' },
    badOutput: { report: { nodesOut: 1 } },
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

describe('WORLD_TOOLS', () => {
  it('lists exactly the ten spec tools and nothing destructive', () => {
    expect(WORLD_TOOL_NAMES.sort()).toEqual([
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

describe.each(cases)('$tool', (c) => {
  it('round-trips a valid call', async () => {
    const { transport, callTool } = mockTransport(c.output);
    const client = createWorldClient({ transport });
    const result = await method(client, c.method)(c.input);
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(callTool.mock.calls[0]![0]).toBe(c.tool);
    expect(result).toEqual(WORLD_TOOLS[c.tool].output.parse(c.output));
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
});

describe('input contract details', () => {
  it('rejects unknown keys at the top level of every tool', async () => {
    for (const c of cases) {
      const { transport, callTool } = mockTransport(c.output);
      const client = createWorldClient({ transport });
      await expect(method(client, c.method)({ ...c.input, extra: true })).rejects.toBeInstanceOf(WorldClientValidationError);
      expect(callTool).not.toHaveBeenCalled();
    }
  });

  it('get_region needs exactly one of regionId or bounds', async () => {
    const { transport, callTool } = mockTransport({});
    const client = createWorldClient({ transport, worldId: 'arcanea' });
    await expect(client.getRegion({})).rejects.toBeInstanceOf(WorldClientValidationError);
    expect(callTool).not.toHaveBeenCalled();
  });

  it('link rejects a self edge locally', async () => {
    const { transport, callTool } = mockTransport({ edge, worldVersion: 1 });
    const client = createWorldClient({ transport, worldId: 'arcanea' });
    await expect(client.link({ from: 'n_a', to: 'n_a', relation: 'rules' })).rejects.toBeInstanceOf(WorldClientValidationError);
    expect(callTool).not.toHaveBeenCalled();
  });

  it('add_node sends the parsed node and allows an explicit id', async () => {
    const { transport, callTool } = mockTransport({ node, worldVersion: 1 });
    const client = createWorldClient({ transport, worldId: 'arcanea' });
    await client.addNode({ node: { id: 'n_arion', kind: 'character', title: 'Arion', position: { x: 0, y: 0 } } });
    expect(callTool).toHaveBeenCalledWith('add_node', {
      worldId: 'arcanea',
      node: { id: 'n_arion', kind: 'character', title: 'Arion', position: { x: 0, y: 0 } },
    });
  });

  it('accepts output with extra server fields and strips them', async () => {
    const { transport } = mockTransport({ node: { ...node, futureField: 1 }, worldVersion: 3, serverHint: 'x' });
    const client = createWorldClient({ transport, worldId: 'arcanea' });
    const result = await client.updateNode({ id: 'n_arion', baseVersion: 1, patch: { title: 'Arion' } });
    expect(result).not.toHaveProperty('serverHint');
    expect(result.node).not.toHaveProperty('futureField');
    expect(result.worldVersion).toBe(3);
  });
});

describe('canon gate', () => {
  async function expectRejected(run: (client: ReturnType<typeof createWorldClient>) => Promise<unknown>) {
    const { transport, callTool } = mockTransport({});
    const client = createWorldClient({ transport, worldId: 'arcanea' });
    const error = await run(client).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WorldClientValidationError);
    expect((error as WorldClientValidationError).direction).toBe('input');
    expect(callTool).not.toHaveBeenCalled();
  }

  it('add_node cannot carry canon status "canon"', async () => {
    await expectRejected((client) => client.addNode({
      node: { kind: 'god', title: 'Nero', position: { x: 0, y: 0 }, canon: { status: 'canon', ref: 'https://example.com/pr/1' } as never },
    }));
  });

  it('update_node patch cannot carry canon', async () => {
    await expectRejected((client) => client.updateNode({
      id: 'n_arion', baseVersion: 1, patch: { title: 'Arion', canon: { status: 'canon', ref: 'https://example.com/pr/1' } } as never,
    }));
  });

  it('update_node patch cannot carry version or createdBy', async () => {
    await expectRejected((client) => client.updateNode({ id: 'n_arion', baseVersion: 1, patch: { version: 99 } as never }));
    await expectRejected((client) => client.updateNode({ id: 'n_arion', baseVersion: 1, patch: { createdBy: actor } as never }));
  });

  it('link cannot carry canon', async () => {
    await expectRejected((client) => client.link({
      from: 'n_a', to: 'n_b', relation: 'rules', canon: { status: 'canon' },
    } as never));
  });

  it('move items cannot carry canon', async () => {
    await expectRejected((client) => client.move({
      moves: [{ id: 'n_a', baseVersion: 1, position: { x: 0, y: 0 }, canon: { status: 'canon' } }],
    } as never));
  });

  it('propose_canon cannot carry status or ref', async () => {
    const base = { target: { type: 'node' as const, id: 'n_arion' }, baseVersion: 2, note: 'Please' };
    await expectRejected((client) => client.proposeCanon({ ...base, ref: 'https://github.com/x/y/pull/1' } as never));
    await expectRejected((client) => client.proposeCanon({ ...base, status: 'canon' } as never));
    await expectRejected((client) => client.proposeCanon({ ...base, target: { ...base.target, status: 'canon' } } as never));
  });
});

describe('default world', () => {
  it('fills worldId for world-scoped tools and lets an explicit one win', async () => {
    const { transport, callTool } = mockTransport({ world, counts: { nodes: {}, edges: {} }, worldVersion: 7 });
    const client = createWorldClient({ transport, worldId: 'arcanea' });
    expect(client.worldId).toBe('arcanea');
    await client.getWorld({});
    await client.getWorld({ worldId: 'other' });
    expect(callTool.mock.calls.map((call) => call[1])).toEqual([{ worldId: 'arcanea' }, { worldId: 'other' }]);
  });

  it('does not fill worldId for import_whiteboard', async () => {
    const { transport, callTool } = mockTransport({ report: {}, worldId: 'board' });
    const client = createWorldClient({ transport, worldId: 'arcanea' });
    await client.importWhiteboard({ whiteboard: { elements: {} } });
    expect(callTool.mock.calls[0]![1]).not.toHaveProperty('worldId');
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
      code: 'STALE_VERSION', message: 'node n_arion is at version 3', opIndex: 0, id: 'n_arion', expectedVersion: 2, actualVersion: 3,
    });
    const transport: WorldTransport = { callTool: vi.fn(async () => { throw stale; }) };
    const client = createWorldClient({ transport, worldId: 'arcanea' });
    const error = await client.updateNode({ id: 'n_arion', baseVersion: 2, patch: { title: 'A' } }).catch((e: unknown) => e);
    expect(error).toBe(stale);
    expect((error as WorldToolError).isStale).toBe(true);
    expect((error as WorldToolError).expectedVersion).toBe(2);
    expect((error as WorldToolError).actualVersion).toBe(3);
  });
});

describe('review fixes', () => {
  it('sends the parsed input (defaults applied, non-strict nested keys stripped), not the raw input', async () => {
    const { transport, callTool } = mockTransport({ node, worldVersion: 1 });
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

  it.each([
    ['update_node', 'updateNode', { id: 'n_a', patch: { title: 'A' } }],
    ['propose_canon', 'proposeCanon', { target: { type: 'node', id: 'n_a' }, note: 'why' }],
  ])('%s rejects baseVersion 0 and a missing baseVersion', async (_tool, name, base) => {
    for (const args of [{ ...base, baseVersion: 0 }, base, { ...base, baseVersion: 1.5 }]) {
      const { transport, callTool } = mockTransport({});
      const client = createWorldClient({ transport, worldId: 'arcanea' });
      await expect(method(client, name)(args)).rejects.toBeInstanceOf(WorldClientValidationError);
      expect(callTool).not.toHaveBeenCalled();
    }
  });

  it('move rejects baseVersion 0 and a missing baseVersion on an item', async () => {
    for (const move of [{ id: 'n_a', baseVersion: 0, position: { x: 0, y: 0 } }, { id: 'n_a', position: { x: 0, y: 0 } }]) {
      const { transport, callTool } = mockTransport({});
      const client = createWorldClient({ transport, worldId: 'arcanea' });
      await expect(method(client, 'move')({ moves: [move] })).rejects.toBeInstanceOf(WorldClientValidationError);
      expect(callTool).not.toHaveBeenCalled();
    }
  });

  it('search.limit must be 1..100', async () => {
    for (const limit of [0, 101, 2.5]) {
      const { transport, callTool } = mockTransport({ results: [], worldVersion: 1 });
      const client = createWorldClient({ transport, worldId: 'arcanea' });
      await expect(client.search({ query: 'x', limit })).rejects.toBeInstanceOf(WorldClientValidationError);
      expect(callTool).not.toHaveBeenCalled();
    }
    for (const limit of [1, 100]) {
      const { transport, callTool } = mockTransport({ results: [], worldVersion: 1 });
      const client = createWorldClient({ transport, worldId: 'arcanea' });
      await client.search({ query: 'x', limit });
      expect(callTool).toHaveBeenCalledTimes(1);
    }
  });

  it('import_whiteboard lexicon matches L1 ImportLexicon and is strict', async () => {
    expectTypeOf<z.output<typeof importLexiconSchema>>().toEqualTypeOf<ImportLexicon>();
    const whiteboard = { elements: {} };
    const bad = [
      { kinds: { Nero: 'deity' } },
      { tags: { Nero: 'god' } },
      { kinds: {}, extra: true },
      { aliases: { Nero: 'Nero the First' } },
    ];
    for (const lexicon of bad) {
      const { transport, callTool } = mockTransport({ report: {}, worldId: 'w' });
      const client = createWorldClient({ transport });
      await expect(client.importWhiteboard({ whiteboard, lexicon } as never)).rejects.toBeInstanceOf(WorldClientValidationError);
      expect(callTool).not.toHaveBeenCalled();
    }
    const { transport, callTool } = mockTransport({ report: {}, worldId: 'w' });
    await createWorldClient({ transport }).importWhiteboard({ whiteboard, lexicon: { kinds: { Nero: 'god' }, tags: { Nero: ['first'] } } });
    expect(callTool).toHaveBeenCalledTimes(1);
  });
});
