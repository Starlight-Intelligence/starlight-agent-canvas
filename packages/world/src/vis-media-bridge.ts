import { z } from 'zod';
import { slugify, stableId } from './ids.js';
import {
  addNodeOpSchema,
  graphOpBatchSchema,
  updateNodeOpSchema,
  type GraphOp,
} from './ops.js';
import {
  entityIdSchema,
  isSafeLinkHref,
  LIMITS,
  mediaRoleSchema,
  mediaSchema,
  positionSchema,
  sizeSchema,
  type Media,
  type Position,
  type Size,
} from './schemas.js';

/**
 * Typed VIS `vis.r2-dam-plan.v1` -> World Canvas media node attachment bridge.
 *
 * Runtime-neutral (no Node built-ins), so the same validation and op
 * projection runs in browsers, Node CLIs, and Cloudflare Workers (`world-edge`).
 *
 * Security & canon invariants enforced here:
 * - Private R2 contract only: rejects `*.workers.dev` and `*.r2.dev` origins.
 * - Hardened content-addressed keys: rejects traversal/encoding tricks and
 *   verifies `masters/<2>/<64>` + `renditions/<2>/<64>.(thumb|preview).webp`
 *   match each asset's 64-char SHA-256.
 * - QA gate: enforces `qaScore >= 26` on manifest items.
 * - Canon gate: projected ops always carry `canon: { status: 'draft' }` (never `'canon'`).
 */

export const VIS_R2_DAM_PLAN_SCHEMA_VERSION = 'vis.r2-dam-plan.v1' as const;
export const VIS_DEFAULT_R2_BUCKET = 'starlight-media-private' as const;
export const VIS_QA_GATE_MIN = 26;
export const VIS_QA_GATE_MAX = 30;

export type MediaRole = z.infer<typeof mediaRoleSchema>;
export type VisRenditionKind = 'preview' | 'thumb' | 'master';

const SHA256_HEX_RE = /^[a-f0-9]{64}$/;
const SAFE_VIS_KEY_RE = /^(masters|renditions)\/[A-Za-z0-9._\-/]{1,300}$/;
const FORBIDDEN_PUBLIC_HOST_RE = /(?:^|\.)(?:workers|r2)\.dev$/i;
const BUCKET_NAME_RE = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

export function expectedVisMasterKey(sha256: string): string {
  return `masters/${sha256.slice(0, 2)}/${sha256}`;
}

export function expectedVisRenditionKey(sha256: string, kind: 'thumb' | 'preview'): string {
  return `renditions/${sha256.slice(0, 2)}/${sha256}.${kind}.webp`;
}

/**
 * Validates that a custom worker origin uses HTTPS, contains no credentials,
 * query, or fragment, and never points at public `*.workers.dev` or `*.r2.dev` hosts.
 */
export function isPrivateVisOrigin(value: string): boolean {
  if (typeof value !== 'string' || value.trim().length === 0) return false;
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  if (parsed.username || parsed.password || parsed.search || parsed.hash) return false;
  if (FORBIDDEN_PUBLIC_HOST_RE.test(parsed.hostname)) return false;
  return parsed.hostname.length > 0;
}

/**
 * Hardened VIS R2 object key validator aligned with `visual-intelligence`
 * (`core/vis-r2-dam-plan.mjs` & `workers/vis-media/src/index.js`).
 */
export function isSafeVisR2Key(key: string, expectedSha256?: string): boolean {
  if (typeof key !== 'string' || key.length === 0 || key.length > 1024) return false;
  if (
    key.includes('\0')
    || key.includes('\\')
    || key.includes('..')
    || /%2e/i.test(key)
    || /%2f/i.test(key)
    || /%5c/i.test(key)
  ) {
    return false;
  }
  if (!SAFE_VIS_KEY_RE.test(key)) return false;
  if (expectedSha256 !== undefined) {
    if (!SHA256_HEX_RE.test(expectedSha256)) return false;
    if (key.startsWith('masters/')) {
      return key === expectedVisMasterKey(expectedSha256);
    }
    if (key.startsWith('renditions/')) {
      return (
        key === expectedVisRenditionKey(expectedSha256, 'thumb')
        || key === expectedVisRenditionKey(expectedSha256, 'preview')
      );
    }
    return false;
  }
  return true;
}

function isNonForbiddenTargetUrl(value: string): boolean {
  if (!isSafeLinkHref(value)) return false;
  if (/^https?:\/\//i.test(value)) {
    try {
      const parsed = new URL(value);
      if (FORBIDDEN_PUBLIC_HOST_RE.test(parsed.hostname)) return false;
    } catch {
      return false;
    }
  }
  return true;
}

export const visUsageEdgeSchema = z.object({
  domain: z.string().min(1).max(255).nullable().optional(),
  route: z.string().min(1).max(512).nullable().optional(),
  component: z.string().min(1).max(255).nullable().optional(),
  sourceFile: z.string().min(1).max(512).nullable().optional(),
});
export type VisUsageEdge = z.infer<typeof visUsageEdgeSchema>;

export const visAccessModeSchema = z.enum(['private-worker-binding', 'private-custom-domain']);
export type VisAccessMode = z.infer<typeof visAccessModeSchema>;

export const visR2DescriptorSchema = z.object({
  bucket: z.string().regex(BUCKET_NAME_RE, 'bucket must be a valid lowercase R2 bucket name.'),
  accessMode: visAccessModeSchema,
  masterKey: z.string().min(1).max(1024),
  thumbKey: z.string().min(1).max(1024),
  previewKey: z.string().min(1).max(1024),
  putMasterEndpoint: z.string().min(1).max(2048).optional(),
  putPreviewEndpoint: z.string().min(1).max(2048).optional(),
  putThumbEndpoint: z.string().min(1).max(2048).optional(),
  signedPreviewPattern: z.string().min(1).max(2048).optional(),
  signedThumbPattern: z.string().min(1).max(2048).optional(),
});
export type VisR2Descriptor = z.infer<typeof visR2DescriptorSchema>;

export const visR2ManifestItemSchema = z.object({
  assetId: z.string().min(1).max(200),
  brand: z.string().min(1).max(100),
  sha256: z.string().regex(SHA256_HEX_RE, 'sha256 must be a 64-character lowercase hex digest.'),
  qaScore: z.number().finite().min(VIS_QA_GATE_MIN, `qaScore must meet VIS gate (>= ${VIS_QA_GATE_MIN}).`).max(VIS_QA_GATE_MAX),
  r2: visR2DescriptorSchema,
  driveMirrorPath: z.string().min(1).max(1024).optional(),
  derivatives: z.array(z.string().min(1).max(512)).default([]),
  targetUrls: z.array(z.string().refine(isNonForbiddenTargetUrl, {
    message: 'targetUrl must be a safe link and may not point at workers.dev or r2.dev.',
  })).default([]),
  usedIn: z.array(visUsageEdgeSchema).default([]),
  usageCount: z.number().int().nonnegative().optional(),
  hasActivePlacement: z.boolean().optional(),
}).superRefine((item, ctx) => {
  if (!isSafeVisR2Key(item.r2.masterKey, item.sha256) || item.r2.masterKey !== expectedVisMasterKey(item.sha256)) {
    ctx.addIssue({
      code: 'custom',
      path: ['r2', 'masterKey'],
      message: `masterKey must equal ${expectedVisMasterKey(item.sha256)}.`,
    });
  }
  if (!isSafeVisR2Key(item.r2.thumbKey, item.sha256) || item.r2.thumbKey !== expectedVisRenditionKey(item.sha256, 'thumb')) {
    ctx.addIssue({
      code: 'custom',
      path: ['r2', 'thumbKey'],
      message: `thumbKey must equal ${expectedVisRenditionKey(item.sha256, 'thumb')}.`,
    });
  }
  if (!isSafeVisR2Key(item.r2.previewKey, item.sha256) || item.r2.previewKey !== expectedVisRenditionKey(item.sha256, 'preview')) {
    ctx.addIssue({
      code: 'custom',
      path: ['r2', 'previewKey'],
      message: `previewKey must equal ${expectedVisRenditionKey(item.sha256, 'preview')}.`,
    });
  }
  if (item.usageCount !== undefined && item.usageCount !== item.usedIn.length) {
    ctx.addIssue({
      code: 'custom',
      path: ['usageCount'],
      message: `usageCount (${item.usageCount}) does not match usedIn.length (${item.usedIn.length}).`,
    });
  }
});
export type VisR2ManifestItem = z.infer<typeof visR2ManifestItemSchema>;

export const visSkippedItemSchema = z.object({
  assetId: z.string().min(1).max(200).optional(),
  reason: z.string().min(1).max(300),
});

export const visR2DamPlanSchema = z.object({
  schemaVersion: z.literal(VIS_R2_DAM_PLAN_SCHEMA_VERSION),
  generatedAt: z.iso.datetime(),
  dryRun: z.boolean(),
  bucket: z.string().regex(BUCKET_NAME_RE, 'bucket must be a valid lowercase R2 bucket name.'),
  workerBase: z.string().refine(isPrivateVisOrigin, {
    message: 'workerBase must be a private custom HTTPS origin (workers.dev and r2.dev are forbidden).',
  }).nullable().optional(),
  accessMode: visAccessModeSchema,
  readyCount: z.number().int().nonnegative(),
  skippedCount: z.number().int().nonnegative(),
  totalUsageEdges: z.number().int().nonnegative().optional(),
  uploadManifest: z.array(visR2ManifestItemSchema).default([]),
  skipped: z.array(visSkippedItemSchema).default([]),
}).superRefine((plan, ctx) => {
  const expectedMode: VisAccessMode = plan.workerBase ? 'private-custom-domain' : 'private-worker-binding';
  if (plan.accessMode !== expectedMode) {
    ctx.addIssue({
      code: 'custom',
      path: ['accessMode'],
      message: `accessMode "${plan.accessMode}" does not match workerBase (${expectedMode}).`,
    });
  }
  if (plan.readyCount !== plan.uploadManifest.length) {
    ctx.addIssue({
      code: 'custom',
      path: ['readyCount'],
      message: `readyCount (${plan.readyCount}) does not match uploadManifest.length (${plan.uploadManifest.length}).`,
    });
  }
  if (plan.skippedCount !== plan.skipped.length) {
    ctx.addIssue({
      code: 'custom',
      path: ['skippedCount'],
      message: `skippedCount (${plan.skippedCount}) does not match skipped.length (${plan.skipped.length}).`,
    });
  }
  const seenAssets = new Set<string>();
  const seenShas = new Set<string>();
  for (let i = 0; i < plan.uploadManifest.length; i++) {
    const item = plan.uploadManifest[i]!;
    if (item.r2.bucket !== plan.bucket) {
      ctx.addIssue({
        code: 'custom',
        path: ['uploadManifest', i, 'r2', 'bucket'],
        message: `item bucket "${item.r2.bucket}" differs from plan bucket "${plan.bucket}".`,
      });
    }
    if (item.r2.accessMode !== plan.accessMode) {
      ctx.addIssue({
        code: 'custom',
        path: ['uploadManifest', i, 'r2', 'accessMode'],
        message: `item accessMode "${item.r2.accessMode}" differs from plan accessMode "${plan.accessMode}".`,
      });
    }
    if (seenAssets.has(item.assetId)) {
      ctx.addIssue({
        code: 'custom',
        path: ['uploadManifest', i, 'assetId'],
        message: `Duplicate assetId "${item.assetId}" in uploadManifest.`,
      });
    }
    seenAssets.add(item.assetId);
    if (seenShas.has(item.sha256)) {
      ctx.addIssue({
        code: 'custom',
        path: ['uploadManifest', i, 'sha256'],
        message: `Duplicate sha256 "${item.sha256}" in uploadManifest.`,
      });
    }
    seenShas.add(item.sha256);
  }
});
export type VisR2DamPlan = z.infer<typeof visR2DamPlanSchema>;

export interface VisPlanValidationIssue {
  path: string;
  message: string;
}

export type VisPlanValidationResult =
  | { ok: true; plan: VisR2DamPlan }
  | { ok: false; issues: VisPlanValidationIssue[] };

export function validateVisR2DamPlan(input: unknown): VisPlanValidationResult {
  const parsed = visR2DamPlanSchema.safeParse(input);
  if (parsed.success) {
    return { ok: true, plan: parsed.data };
  }
  return {
    ok: false,
    issues: parsed.error.issues.map((issue) => ({
      path: issue.path.length > 0 ? issue.path.join('.') : '(root)',
      message: issue.message,
    })),
  };
}

export interface VisMediaOptions {
  role?: MediaRole;
  rendition?: VisRenditionKind;
  alt?: string;
  href?: string;
  width?: number;
  height?: number;
}

function pickKeyForRendition(item: VisR2ManifestItem, rendition: VisRenditionKind): string {
  switch (rendition) {
    case 'master':
      return item.r2.masterKey;
    case 'thumb':
      return item.r2.thumbKey;
    case 'preview':
    default:
      return item.r2.previewKey;
  }
}

/**
 * Converts one validated VIS manifest item into a World Graph v1 `Media`
 * descriptor backed by its private content-addressed R2 key.
 */
export function visAssetToMedia(item: VisR2ManifestItem, opts: VisMediaOptions = {}): Media {
  const rendition = opts.rendition ?? 'preview';
  const r2Key = pickKeyForRendition(item, rendition);
  const role: MediaRole = opts.role ?? 'plate';
  const alt = (opts.alt ?? `${item.brand}: ${item.assetId}`).slice(0, LIMITS.titleMax);
  const candidateHref = opts.href ?? item.targetUrls[0];

  const draft: Record<string, unknown> = {
    r2Key,
    alt,
    role,
  };
  if (candidateHref !== undefined && isNonForbiddenTargetUrl(candidateHref)) {
    draft.href = candidateHref;
  }
  if (opts.width !== undefined) draft.width = opts.width;
  if (opts.height !== undefined) draft.height = opts.height;

  return mediaSchema.parse(draft);
}

/** Deterministic World Graph node id for a VIS content-addressed asset. */
export function visAssetNodeId(item: Pick<VisR2ManifestItem, 'sha256' | 'assetId'>): string {
  return stableId('n', `vis:${item.sha256}`, item.assetId);
}

export interface VisImageNodeOptions extends VisMediaOptions {
  nodeId?: string;
  title?: string;
  summary?: string;
  position: Position;
  size?: Size;
  regionId?: string | null;
  layer?: number;
  tags?: readonly string[];
}

function buildVisProvenanceMeta(item: VisR2ManifestItem, rendition: VisRenditionKind): Record<string, unknown> {
  const provenance: Record<string, unknown> = {
    schemaVersion: VIS_R2_DAM_PLAN_SCHEMA_VERSION,
    assetId: item.assetId,
    brand: item.brand,
    sha256: item.sha256,
    qaScore: item.qaScore,
    bucket: item.r2.bucket,
    accessMode: item.r2.accessMode,
    rendition,
    masterKey: item.r2.masterKey,
    previewKey: item.r2.previewKey,
    thumbKey: item.r2.thumbKey,
    usedIn: item.usedIn,
  };
  if (item.driveMirrorPath !== undefined) {
    provenance.driveMirrorPath = item.driveMirrorPath;
  }
  return provenance;
}

function normalizeTags(brand: string, extra?: readonly string[]): string[] {
  const set = new Set<string>();
  set.add('vis');
  const brandTag = slugify(brand, LIMITS.tagMax);
  if (brandTag) set.add(brandTag);
  for (const raw of extra ?? []) {
    const trimmed = raw.trim().slice(0, LIMITS.tagMax);
    if (trimmed) set.add(trimmed);
    if (set.size >= LIMITS.tagsMax) break;
  }
  return [...set];
}

/**
 * Projects a single validated VIS manifest item into an `addNode` op for an
 * `image` node in World Graph v1. Always emits `canon: { status: 'draft' }`.
 */
export function visAssetToImageNodeOp(item: VisR2ManifestItem, opts: VisImageNodeOptions): GraphOp {
  const rendition = opts.rendition ?? 'preview';
  const media = visAssetToMedia(item, opts);
  const id = opts.nodeId ? entityIdSchema.parse(opts.nodeId) : visAssetNodeId(item);
  const title = (opts.title ?? item.assetId).trim().slice(0, LIMITS.titleMax) || item.assetId;
  const summary = (opts.summary ?? `VIS ${item.brand} asset (QA ${item.qaScore}/30)`).slice(0, LIMITS.summaryMax);
  const position = positionSchema.parse(opts.position);

  const node: Record<string, unknown> = {
    id,
    kind: 'image',
    title,
    summary,
    tags: normalizeTags(item.brand, opts.tags),
    canon: { status: 'draft' },
    media: [media],
    position,
    meta: {
      vis: buildVisProvenanceMeta(item, rendition),
    },
  };
  if (opts.size !== undefined) node.size = sizeSchema.parse(opts.size);
  if (opts.regionId !== undefined) node.regionId = opts.regionId === null ? null : entityIdSchema.parse(opts.regionId);
  if (opts.layer !== undefined) node.layer = opts.layer;

  return addNodeOpSchema.parse({ op: 'addNode', node });
}

export interface VisAttachMediaOptions extends VisMediaOptions {
  nodeId: string;
  baseVersion: number;
  existingMedia?: readonly Media[];
  existingMeta?: Record<string, unknown>;
  replaceExisting?: boolean;
}

/**
 * Projects a VIS manifest item into an `updateNode` op that attaches the R2
 * media reference to an existing World Canvas node, deduplicating by `r2Key`
 * and enforcing `LIMITS.mediaMax`.
 */
export function visAssetToAttachMediaOp(item: VisR2ManifestItem, opts: VisAttachMediaOptions): GraphOp {
  const rendition = opts.rendition ?? 'preview';
  const nextMedia = visAssetToMedia(item, opts);
  const prior = opts.replaceExisting ? [] : [...(opts.existingMedia ?? [])];
  const deduped = prior.filter((m) => m.r2Key !== nextMedia.r2Key);
  if (deduped.length >= LIMITS.mediaMax) {
    throw new Error(`Cannot attach VIS media to node ${opts.nodeId}: exceeds LIMITS.mediaMax (${LIMITS.mediaMax}).`);
  }
  deduped.push(nextMedia);

  const prevAttachments = Array.isArray(opts.existingMeta?.visAttachments)
    ? (opts.existingMeta.visAttachments as Record<string, unknown>[]).filter(
      (entry) => entry && entry.sha256 !== item.sha256,
    )
    : [];
  const nextMeta: Record<string, unknown> = {
    ...(opts.existingMeta ?? {}),
    visAttachments: [...prevAttachments, buildVisProvenanceMeta(item, rendition)],
  };

  return updateNodeOpSchema.parse({
    op: 'updateNode',
    id: entityIdSchema.parse(opts.nodeId),
    baseVersion: opts.baseVersion,
    patch: {
      media: deduped,
      meta: nextMeta,
    },
  });
}

export interface VisPlanProjectionOptions {
  /** Optional brand allowlist (case-insensitive). */
  brands?: readonly string[];
  /** When true, only project items that have at least one `usedIn` edge. */
  onlyActivePlacements?: boolean;
  /** Rendition to attach on projected image nodes (defaults to `preview`). */
  rendition?: VisRenditionKind;
  /** Media role to assign (defaults to `plate`). */
  role?: MediaRole;
  /** Owning region id for projected image nodes. */
  regionId?: string | null;
  /** Top-left origin for deterministic grid placement. */
  origin?: Position;
  /** Number of columns in deterministic grid placement (defaults to 4). */
  columns?: number;
  /** Horizontal spacing per column (defaults to 360). */
  cellWidth?: number;
  /** Vertical spacing per row (defaults to 280). */
  cellHeight?: number;
  /** Default node size for projected image cards. */
  cardSize?: Size;
  /** Extra tags applied to every projected node. */
  tags?: readonly string[];
  /** Existing node ids to skip (idempotent re-runs). */
  existingNodeIds?: ReadonlySet<string>;
}

export interface VisPlanProjectionSummary {
  bucket: string;
  accessMode: VisAccessMode;
  totalInPlan: number;
  projectedCount: number;
  filteredOutCount: number;
  alreadyPresentCount: number;
}

export type VisPlanProjectionResult =
  | {
    ok: true;
    plan: VisR2DamPlan;
    ops: GraphOp[];
    nodeIds: string[];
    summary: VisPlanProjectionSummary;
  }
  | {
    ok: false;
    issues: VisPlanValidationIssue[];
  };

/**
 * Validates a `vis.r2-dam-plan.v1` payload and projects approved assets into a
 * ready-to-apply World Graph v1 `GraphOp[]` batch (`addNode` ops with
 * deterministic ids and grid coordinates).
 */
export function planVisMediaOps(
  rawPlan: unknown,
  opts: VisPlanProjectionOptions = {},
): VisPlanProjectionResult {
  const validated = validateVisR2DamPlan(rawPlan);
  if (!validated.ok) return validated;

  const { plan } = validated;
  const brandFilter = opts.brands && opts.brands.length > 0
    ? new Set(opts.brands.map((b) => b.trim().toLowerCase()).filter(Boolean))
    : null;
  const origin = opts.origin ? positionSchema.parse(opts.origin) : { x: 0, y: 0 };
  const columns = Math.max(1, Math.floor(opts.columns ?? 4));
  const cellWidth = Math.max(1, opts.cellWidth ?? 360);
  const cellHeight = Math.max(1, opts.cellHeight ?? 280);
  const existing = opts.existingNodeIds ?? new Set<string>();

  const ops: GraphOp[] = [];
  const nodeIds: string[] = [];
  let filteredOutCount = 0;
  let alreadyPresentCount = 0;

  for (const item of plan.uploadManifest) {
    if (brandFilter && !brandFilter.has(item.brand.trim().toLowerCase())) {
      filteredOutCount++;
      continue;
    }
    if (opts.onlyActivePlacements && item.usedIn.length === 0) {
      filteredOutCount++;
      continue;
    }
    const id = visAssetNodeId(item);
    if (existing.has(id)) {
      alreadyPresentCount++;
      continue;
    }
    if (ops.length >= LIMITS.opsPerBatchMax) {
      return {
        ok: false,
        issues: [{
          path: 'uploadManifest',
          message: `Projected ops exceed LIMITS.opsPerBatchMax (${LIMITS.opsPerBatchMax}). Filter by brand or batch the plan.`,
        }],
      };
    }

    const index = ops.length;
    const col = index % columns;
    const row = Math.floor(index / columns);
    const nodeOpts: VisImageNodeOptions = {
      nodeId: id,
      position: {
        x: origin.x + col * cellWidth,
        y: origin.y + row * cellHeight,
      },
    };
    if (opts.rendition !== undefined) nodeOpts.rendition = opts.rendition;
    if (opts.role !== undefined) nodeOpts.role = opts.role;
    if (opts.regionId !== undefined) nodeOpts.regionId = opts.regionId;
    if (opts.cardSize !== undefined) nodeOpts.size = opts.cardSize;
    if (opts.tags !== undefined) nodeOpts.tags = opts.tags;

    ops.push(visAssetToImageNodeOp(item, nodeOpts));
    nodeIds.push(id);
  }

  const batchCheck = graphOpBatchSchema.safeParse(ops);
  if (!batchCheck.success) {
    return {
      ok: false,
      issues: batchCheck.error.issues.map((issue) => ({
        path: issue.path.length > 0 ? issue.path.join('.') : '(batch)',
        message: issue.message,
      })),
    };
  }

  return {
    ok: true,
    plan,
    ops: batchCheck.data,
    nodeIds,
    summary: {
      bucket: plan.bucket,
      accessMode: plan.accessMode,
      totalInPlan: plan.uploadManifest.length,
      projectedCount: ops.length,
      filteredOutCount,
      alreadyPresentCount,
    },
  };
}
