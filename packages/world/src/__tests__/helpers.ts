import { WORLD_GRAPH_SCHEMA_VERSION, type Actor, type WorldGraph, type WorldNode } from '../schemas.js';

export const T0 = '2026-01-01T00:00:00.000Z';
export const T1 = '2026-01-01T01:00:00.000Z';

export const importer: Actor = { harness: 'importer', at: T0 };
export const claude: Actor = { harness: 'claude', at: T1, actor: 'session-1' };

export function node(id: string, overrides: Partial<WorldNode> = {}): WorldNode {
  return {
    id,
    worldId: 'testland',
    kind: 'character',
    title: `Node ${id}`,
    summary: '',
    body: '',
    tags: [],
    canon: { status: 'draft' },
    media: [],
    position: { x: 0, y: 0 },
    regionId: 'r_core',
    layer: 0,
    createdBy: importer,
    updatedAt: T0,
    version: 1,
    meta: {},
    ...overrides,
  };
}

export function sampleGraph(): WorldGraph {
  return {
    schemaVersion: WORLD_GRAPH_SCHEMA_VERSION,
    world: {
      id: 'testland',
      title: 'Testland',
      summary: '',
      version: 3,
      regions: [
        { id: 'r_core', title: 'Core', bounds: { x: 0, y: 0, w: 1000, h: 1000 }, color: '#ffd700' },
        { id: 'r_edge', title: 'Edge', bounds: { x: 1000, y: 0, w: 1000, h: 1000 } },
      ],
      updatedAt: T0,
    },
    nodes: [
      node('n_a', { title: 'Alpha' }),
      node('n_b', { title: 'Beta', kind: 'place', version: 4 }),
      node('n_canon', { title: 'Locked', kind: 'god', canon: { status: 'canon', ref: 'https://github.com/example/canon/pull/1' } }),
    ],
    edges: [
      {
        id: 'e_ab',
        worldId: 'testland',
        from: 'n_a',
        to: 'n_b',
        relation: 'located-at',
        canon: { status: 'draft' },
        createdBy: importer,
        updatedAt: T0,
        version: 1,
        meta: {},
      },
      {
        id: 'e_canon',
        worldId: 'testland',
        from: 'n_canon',
        to: 'n_b',
        relation: 'rules',
        canon: { status: 'canon', ref: 'https://github.com/example/canon/pull/2' },
        createdBy: importer,
        updatedAt: T0,
        version: 2,
        meta: {},
      },
    ],
  };
}
