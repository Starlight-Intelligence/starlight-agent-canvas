import { describe, expect, it } from 'vitest';
import { applyOps } from '../ops.js';
import { LIMITS } from '../schemas.js';
import {
  expectedVisMasterKey,
  expectedVisRenditionKey,
  isPrivateVisOrigin,
  isSafeVisR2Key,
  planVisMediaOps,
  validateVisR2DamPlan,
  VIS_DEFAULT_R2_BUCKET,
  VIS_R2_DAM_PLAN_SCHEMA_VERSION,
  visAssetNodeId,
  visAssetToAttachMediaOp,
  visAssetToImageNodeOp,
  visAssetToMedia,
  type VisR2DamPlan,
  type VisR2ManifestItem,
} from '../vis-media-bridge.js';
import { claude, sampleGraph } from './helpers.js';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

function makeItem(
  sha256: string,
  overrides: Partial<VisR2ManifestItem> = {},
): VisR2ManifestItem {
  const bucket = overrides.r2?.bucket ?? VIS_DEFAULT_R2_BUCKET;
  const accessMode = overrides.r2?.accessMode ?? 'private-worker-binding';
  return {
    assetId: `asset-${sha256.slice(0, 6)}`,
    brand: 'starlight',
    sha256,
    qaScore: 28,
    r2: {
      bucket,
      accessMode,
      masterKey: expectedVisMasterKey(sha256),
      thumbKey: expectedVisRenditionKey(sha256, 'thumb'),
      previewKey: expectedVisRenditionKey(sha256, 'preview'),
      putMasterEndpoint: `/o/${expectedVisMasterKey(sha256)}`,
      putPreviewEndpoint: `/o/${expectedVisRenditionKey(sha256, 'preview')}`,
      putThumbEndpoint: `/o/${expectedVisRenditionKey(sha256, 'thumb')}`,
      signedPreviewPattern: `/r/${sha256}/preview?exp=<unix>&sig=<hmac>`,
      signedThumbPattern: `/r/${sha256}/thumb?exp=<unix>&sig=<hmac>`,
      ...overrides.r2,
    },
    driveMirrorPath: `Google Drive/Starlight Creative Vault/04_APPROVED_MASTERS/starlight/${sha256.slice(0, 6)}.png`,
    derivatives: [],
    targetUrls: ['https://starlightintelligence.ai/studio'],
    usedIn: [
      {
        domain: 'starlightintelligence.ai',
        route: '/studio',
        component: 'HeroPlate',
        sourceFile: 'apps/web/app/studio/page.tsx',
      },
    ],
    usageCount: 1,
    hasActivePlacement: true,
    ...overrides,
  };
}

function makePlan(items: VisR2ManifestItem[] = [makeItem(SHA_A)], overrides: Partial<VisR2DamPlan> = {}): VisR2DamPlan {
  return {
    schemaVersion: VIS_R2_DAM_PLAN_SCHEMA_VERSION,
    generatedAt: '2026-11-27T04:00:00.000Z',
    dryRun: true,
    bucket: VIS_DEFAULT_R2_BUCKET,
    workerBase: null,
    accessMode: 'private-worker-binding',
    readyCount: items.length,
    skippedCount: 0,
    totalUsageEdges: items.reduce((sum, i) => sum + i.usedIn.length, 0),
    uploadManifest: items,
    skipped: [],
    ...overrides,
  };
}

describe('VIS vis.r2-dam-plan.v1 validation', () => {
  it('accepts valid private-worker-binding and private-custom-domain plans', () => {
    const bindingPlan = makePlan([makeItem(SHA_A)]);
    const res1 = validateVisR2DamPlan(bindingPlan);
    expect(res1.ok).toBe(true);

    const customItem = makeItem(SHA_B, {
      r2: {
        bucket: VIS_DEFAULT_R2_BUCKET,
        accessMode: 'private-custom-domain',
        masterKey: expectedVisMasterKey(SHA_B),
        thumbKey: expectedVisRenditionKey(SHA_B, 'thumb'),
        previewKey: expectedVisRenditionKey(SHA_B, 'preview'),
      },
    });
    const customPlan = makePlan([customItem], {
      workerBase: 'https://media.starlightintelligence.ai',
      accessMode: 'private-custom-domain',
    });
    const res2 = validateVisR2DamPlan(customPlan);
    expect(res2.ok).toBe(true);
  });

  it('rejects workers.dev, r2.dev, non-HTTPS, and credentialed workerBase origins', () => {
    expect(isPrivateVisOrigin('https://media.starlightintelligence.ai')).toBe(true);
    expect(isPrivateVisOrigin('https://vis-media.frankx.workers.dev')).toBe(false);
    expect(isPrivateVisOrigin('https://pub-123.r2.dev')).toBe(false);
    expect(isPrivateVisOrigin('http://media.starlightintelligence.ai')).toBe(false);
    expect(isPrivateVisOrigin('https://user:pass@media.starlightintelligence.ai')).toBe(false);
    expect(isPrivateVisOrigin('https://media.starlightintelligence.ai?token=1')).toBe(false);

    const bad = makePlan([makeItem(SHA_A)], {
      workerBase: 'https://vis-media.frankx.workers.dev',
      accessMode: 'private-custom-domain',
    });
    const result = validateVisR2DamPlan(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.path === 'workerBase')).toBe(true);
    }
  });

  it('rejects traversal keys, encoded dots, and SHA-256 key mismatches', () => {
    expect(isSafeVisR2Key(expectedVisMasterKey(SHA_A), SHA_A)).toBe(true);
    expect(isSafeVisR2Key(expectedVisRenditionKey(SHA_A, 'preview'), SHA_A)).toBe(true);
    expect(isSafeVisR2Key(`masters/../${SHA_A}`, SHA_A)).toBe(false);
    expect(isSafeVisR2Key(`masters/%2e%2e/${SHA_A}`, SHA_A)).toBe(false);
    expect(isSafeVisR2Key(`masters\\aa\\${SHA_A}`, SHA_A)).toBe(false);
    expect(isSafeVisR2Key(expectedVisMasterKey(SHA_B), SHA_A)).toBe(false);

    const tampered = makePlan([
      makeItem(SHA_A, {
        r2: {
          bucket: VIS_DEFAULT_R2_BUCKET,
          accessMode: 'private-worker-binding',
          masterKey: expectedVisMasterKey(SHA_B),
          thumbKey: expectedVisRenditionKey(SHA_A, 'thumb'),
          previewKey: expectedVisRenditionKey(SHA_A, 'preview'),
        },
      }),
    ]);
    const result = validateVisR2DamPlan(tampered);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.path.includes('masterKey'))).toBe(true);
    }
  });

  it('rejects below-gate QA scores, duplicate SHA-256 entries, count drift, and forbidden targetUrls', () => {
    const lowQa = makePlan([makeItem(SHA_A, { qaScore: 25 })]);
    expect(validateVisR2DamPlan(lowQa).ok).toBe(false);

    const dupSha = makePlan([
      makeItem(SHA_A, { assetId: 'asset-1' }),
      makeItem(SHA_A, { assetId: 'asset-2' }),
    ]);
    expect(validateVisR2DamPlan(dupSha).ok).toBe(false);

    const countDrift = makePlan([makeItem(SHA_A)], { readyCount: 2 });
    expect(validateVisR2DamPlan(countDrift).ok).toBe(false);

    const badHref = makePlan([makeItem(SHA_A, { targetUrls: ['javascript:alert(1)'] })]);
    expect(validateVisR2DamPlan(badHref).ok).toBe(false);

    const leakedWorkersDevTarget = makePlan([
      makeItem(SHA_A, { targetUrls: ['https://vis-media.workers.dev/r/x'] }),
    ]);
    expect(validateVisR2DamPlan(leakedWorkersDevTarget).ok).toBe(false);
  });
});

describe('VIS -> World Canvas media projection & ops reducer', () => {
  it('projects a validated plan into deterministic draft image nodes and applies cleanly to WorldGraph', () => {
    const plan = makePlan([
      makeItem(SHA_A, { assetId: 'hero-gate', brand: 'arcanea' }),
      makeItem(SHA_B, { assetId: 'glass-card', brand: 'starlight', usedIn: [], usageCount: 0, hasActivePlacement: false }),
    ]);

    const projected = planVisMediaOps(plan, {
      regionId: 'r_core',
      origin: { x: 100, y: 200 },
      columns: 2,
      cellWidth: 400,
      cellHeight: 300,
      tags: ['wave-5'],
    });
    expect(projected.ok).toBe(true);
    if (!projected.ok) return;

    expect(projected.ops).toHaveLength(2);
    expect(projected.summary).toMatchObject({
      bucket: VIS_DEFAULT_R2_BUCKET,
      accessMode: 'private-worker-binding',
      totalInPlan: 2,
      projectedCount: 2,
      filteredOutCount: 0,
      alreadyPresentCount: 0,
    });

    const applied = applyOps(sampleGraph(), projected.ops, { actor: claude });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;

    expect(applied.applied).toBe(2);
    const heroId = visAssetNodeId({ sha256: SHA_A, assetId: 'hero-gate' });
    const heroNode = applied.graph.nodes.find((n) => n.id === heroId);
    expect(heroNode).toBeDefined();
    expect(heroNode?.kind).toBe('image');
    expect(heroNode?.canon).toEqual({ status: 'draft' });
    expect(heroNode?.regionId).toBe('r_core');
    expect(heroNode?.position).toEqual({ x: 100, y: 200 });
    expect(heroNode?.media).toEqual([
      {
        r2Key: expectedVisRenditionKey(SHA_A, 'preview'),
        alt: 'arcanea: hero-gate',
        role: 'plate',
        href: 'https://starlightintelligence.ai/studio',
      },
    ]);
    expect(heroNode?.meta).toMatchObject({
      vis: {
        schemaVersion: VIS_R2_DAM_PLAN_SCHEMA_VERSION,
        assetId: 'hero-gate',
        brand: 'arcanea',
        sha256: SHA_A,
        qaScore: 28,
        bucket: VIS_DEFAULT_R2_BUCKET,
      },
    });

    // Idempotent re-run skips already-present node IDs.
    const rerun = planVisMediaOps(plan, {
      existingNodeIds: new Set(applied.graph.nodes.map((n) => n.id)),
    });
    expect(rerun.ok).toBe(true);
    if (rerun.ok) {
      expect(rerun.ops).toHaveLength(0);
      expect(rerun.summary.alreadyPresentCount).toBe(2);
    }
  });

  it('filters by brand and onlyActivePlacements', () => {
    const plan = makePlan([
      makeItem(SHA_A, { assetId: 'arc-active', brand: 'Arcanea' }),
      makeItem(SHA_B, { assetId: 'arc-idle', brand: 'Arcanea', usedIn: [], usageCount: 0, hasActivePlacement: false }),
    ]);
    const filtered = planVisMediaOps(plan, {
      brands: ['arcanea'],
      onlyActivePlacements: true,
      rendition: 'thumb',
      role: 'reference',
    });
    expect(filtered.ok).toBe(true);
    if (!filtered.ok) return;
    expect(filtered.ops).toHaveLength(1);
    expect(filtered.summary.filteredOutCount).toBe(1);
    const op = filtered.ops[0]!;
    expect(op.op).toBe('addNode');
    if (op.op === 'addNode') {
      expect(op.node.media?.[0]?.r2Key).toBe(expectedVisRenditionKey(SHA_A, 'thumb'));
      expect(op.node.media?.[0]?.role).toBe('reference');
    }
  });

  it('attaches VIS media to an existing node via updateNode, deduplicating r2Key and respecting mediaMax', () => {
    const graph = sampleGraph();
    const target = graph.nodes.find((n) => n.id === 'n_a')!;
    const itemA = makeItem(SHA_A, { assetId: 'portrait-a' });
    const itemB = makeItem(SHA_B, { assetId: 'cover-b' });

    const attach1 = visAssetToAttachMediaOp(itemA, {
      nodeId: target.id,
      baseVersion: target.version,
      existingMedia: target.media,
      existingMeta: target.meta,
      role: 'portrait',
    });
    const r1 = applyOps(graph, [attach1], { actor: claude });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;

    const updatedA = r1.graph.nodes.find((n) => n.id === 'n_a')!;
    expect(updatedA.media).toHaveLength(1);
    expect(updatedA.media[0]?.role).toBe('portrait');

    // Re-attaching same r2Key deduplicates instead of duplicating; attaching second asset appends.
    const dedupeOp = visAssetToAttachMediaOp(itemA, {
      nodeId: updatedA.id,
      baseVersion: updatedA.version,
      existingMedia: updatedA.media,
      existingMeta: updatedA.meta,
      role: 'cover',
    });
    const r2 = applyOps(r1.graph, [dedupeOp], { actor: claude });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    const afterDedupe = r2.graph.nodes.find((n) => n.id === 'n_a')!;
    expect(afterDedupe.media).toHaveLength(1);
    expect(afterDedupe.media[0]?.role).toBe('cover');

    const attach2 = visAssetToAttachMediaOp(itemB, {
      nodeId: afterDedupe.id,
      baseVersion: afterDedupe.version,
      existingMedia: afterDedupe.media,
      existingMeta: afterDedupe.meta,
      rendition: 'master',
      role: 'plate',
    });
    const r3 = applyOps(r2.graph, [attach2], { actor: claude });
    expect(r3.ok).toBe(true);
    if (!r3.ok) return;
    const afterTwo = r3.graph.nodes.find((n) => n.id === 'n_a')!;
    expect(afterTwo.media).toHaveLength(2);
    expect(afterTwo.media[1]?.r2Key).toBe(expectedVisMasterKey(SHA_B));

    // Enforces LIMITS.mediaMax when existing media is already full.
    const fullMedia = Array.from({ length: LIMITS.mediaMax }, (_, idx) =>
      visAssetToMedia(makeItem(String(idx).padStart(64, '0'))),
    );
    expect(() =>
      visAssetToAttachMediaOp(itemA, {
        nodeId: 'n_a',
        baseVersion: 1,
        existingMedia: fullMedia,
      }),
    ).toThrow(/LIMITS\.mediaMax/);
  });

  it('produces valid image node ops directly via visAssetToImageNodeOp', () => {
    const item = makeItem(SHA_A, { assetId: 'single-plate' });
    const op = visAssetToImageNodeOp(item, {
      position: { x: 42, y: 84 },
      size: { w: 320, h: 240 },
      rendition: 'master',
      role: 'illustration',
    });
    expect(op.op).toBe('addNode');
    if (op.op === 'addNode') {
      expect(op.node.canon).toEqual({ status: 'draft' });
      expect(op.node.media?.[0]?.r2Key).toBe(expectedVisMasterKey(SHA_A));
      expect(op.node.size).toEqual({ w: 320, h: 240 });
    }
  });
});
