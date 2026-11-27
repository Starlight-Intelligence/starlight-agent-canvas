import {
  expectedVisMasterKey,
  expectedVisRenditionKey,
  planVisMediaOps,
  VIS_DEFAULT_R2_BUCKET,
  VIS_R2_DAM_PLAN_SCHEMA_VERSION,
  visAssetToAttachMediaOp,
  type VisR2DamPlan,
  type WorldNode,
} from '@starlight-agent-canvas/world';
import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { WriteResult } from '../src/world-agent.js';
import { agentFor, bearer, claude, nodeOp, testEnv, worldName } from './helpers.js';

const BASE = 'https://world-edge.test';
const SHA_HERO = '1'.repeat(64);
const SHA_PLATE = '2'.repeat(64);

function sampleVisPlan(): VisR2DamPlan {
  return {
    schemaVersion: VIS_R2_DAM_PLAN_SCHEMA_VERSION,
    generatedAt: '2026-11-27T04:30:00.000Z',
    dryRun: true,
    bucket: VIS_DEFAULT_R2_BUCKET,
    workerBase: 'https://media.starlightintelligence.ai',
    accessMode: 'private-custom-domain',
    readyCount: 2,
    skippedCount: 0,
    totalUsageEdges: 1,
    uploadManifest: [
      {
        assetId: 'arcanea-gate-hero',
        brand: 'arcanea',
        sha256: SHA_HERO,
        qaScore: 29,
        r2: {
          bucket: VIS_DEFAULT_R2_BUCKET,
          accessMode: 'private-custom-domain',
          masterKey: expectedVisMasterKey(SHA_HERO),
          thumbKey: expectedVisRenditionKey(SHA_HERO, 'thumb'),
          previewKey: expectedVisRenditionKey(SHA_HERO, 'preview'),
        },
        driveMirrorPath: 'Google Drive/Starlight Creative Vault/04_APPROVED_MASTERS/arcanea/gate-hero.png',
        derivatives: [],
        targetUrls: ['https://starlightintelligence.ai/worlds/arcanea'],
        usedIn: [
          {
            domain: 'starlightintelligence.ai',
            route: '/worlds/arcanea',
            component: 'WorldHero',
            sourceFile: 'apps/web/app/worlds/arcanea/page.tsx',
          },
        ],
        usageCount: 1,
        hasActivePlacement: true,
      },
      {
        assetId: 'sis-crystal-plate',
        brand: 'starlight',
        sha256: SHA_PLATE,
        qaScore: 27,
        r2: {
          bucket: VIS_DEFAULT_R2_BUCKET,
          accessMode: 'private-custom-domain',
          masterKey: expectedVisMasterKey(SHA_PLATE),
          thumbKey: expectedVisRenditionKey(SHA_PLATE, 'thumb'),
          previewKey: expectedVisRenditionKey(SHA_PLATE, 'preview'),
        },
        derivatives: [],
        targetUrls: [],
        usedIn: [],
        usageCount: 0,
        hasActivePlacement: false,
      },
    ],
    skipped: [],
  };
}

describe('VIS vis.r2-dam-plan.v1 bridge on WorldEdge', () => {
  it('applies projected VIS image node ops and attachment ops to WorldAgent DO and persists media provenance', async () => {
    const worldId = worldName('vis-bridge');
    const agent = await agentFor(worldId);

    // Seed one existing character node to receive a VIS media attachment.
    const seeded = (await agent.applyBatch([nodeOp('n_hero', 0, 0)], claude)) as WriteResult;
    expect(seeded.ok).toBe(true);

    const plan = sampleVisPlan();
    const projected = planVisMediaOps(plan, {
      origin: { x: 200, y: 100 },
      columns: 2,
      tags: ['dam-sync'],
    });
    expect(projected.ok).toBe(true);
    if (!projected.ok) return;

    const addResult = (await agent.applyBatch(projected.ops, claude)) as WriteResult;
    expect(addResult.ok).toBe(true);
    if (!addResult.ok) return;
    expect(addResult.nodes).toHaveLength(2);
    expect(addResult.nodes.every((n) => n.kind === 'image')).toBe(true);
    expect(addResult.nodes.every((n) => n.canon.status === 'draft')).toBe(true);

    // Attach the first VIS asset onto the existing character node via updateNode.
    const existingHero = ((await agent.getNodesById(['n_hero'])) as WorldNode[])[0]!;
    const attachOp = visAssetToAttachMediaOp(plan.uploadManifest[0]!, {
      nodeId: existingHero.id,
      baseVersion: existingHero.version,
      existingMedia: existingHero.media,
      existingMeta: existingHero.meta,
      role: 'cover',
    });
    const attachResult = (await agent.applyBatch([attachOp], claude)) as WriteResult;
    expect(attachResult.ok).toBe(true);
    if (!attachResult.ok) return;

    const reread = (await agent.getNodesById(['n_hero', projected.nodeIds[0]!])) as WorldNode[];
    const updatedHero = reread.find((n) => n.id === 'n_hero')!;
    const imageNode = reread.find((n) => n.id === projected.nodeIds[0]!)!;

    expect(updatedHero.media).toHaveLength(1);
    expect(updatedHero.media[0]?.r2Key).toBe(expectedVisRenditionKey(SHA_HERO, 'preview'));
    expect(updatedHero.media[0]?.role).toBe('cover');
    expect(imageNode.meta).toMatchObject({
      vis: {
        schemaVersion: VIS_R2_DAM_PLAN_SCHEMA_VERSION,
        sha256: SHA_HERO,
        bucket: VIS_DEFAULT_R2_BUCKET,
      },
    });
  });

  it('delivers projected VIS image nodes through authenticated MCP add_node and blocks cross-world writes', async () => {
    const plan = sampleVisPlan();
    const projected = planVisMediaOps(plan, { brands: ['arcanea'] });
    expect(projected.ok).toBe(true);
    if (!projected.ok) return;
    const firstOp = projected.ops[0]!;
    expect(firstOp.op).toBe('addNode');
    if (firstOp.op !== 'addNode') return;
    // MCP add_node strips canon because server always stamps draft.
    const { canon: _omitted, ...mcpNode } = firstOp.node;

    // Scoped token can add VIS node to its own world ('scoped-world').
    const okRes = await SELF.fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: {
        ...bearer(testEnv.TEST_TOKENS.scoped),
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'add_node',
          arguments: {
            worldId: 'scoped-world',
            node: mcpNode,
          },
        },
      }),
    });
    expect(okRes.status).toBe(200);
    const okBody = await okRes.text();
    expect(okBody).toContain(expectedVisRenditionKey(SHA_HERO, 'preview'));

    // Same scoped token is rejected with WORLD_FORBIDDEN on another world.
    const otherWorld = worldName('other-vis');
    const deniedRes = await SELF.fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: {
        ...bearer(testEnv.TEST_TOKENS.scoped),
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'add_node',
          arguments: {
            worldId: otherWorld,
            node: mcpNode,
          },
        },
      }),
    });
    const deniedBody = await deniedRes.text();
    expect(deniedBody).toContain('WORLD_FORBIDDEN');
  });
});
