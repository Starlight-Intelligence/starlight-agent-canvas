import { z } from 'zod';

/**
 * World Graph v1. This file is the contract shared by the importer (L1),
 * the Cloudflare runtime (L2) and the canvas UI (L3). Additive changes only;
 * anything breaking needs a new WORLD_GRAPH_SCHEMA_VERSION.
 */
export const WORLD_GRAPH_SCHEMA_VERSION = 'starlight.worldGraph.v1' as const;

export const LIMITS = {
  idMax: 128,
  titleMax: 300,
  summaryMax: 2_000,
  bodyMax: 200_000,
  tagsMax: 64,
  tagMax: 64,
  mediaMax: 32,
  labelMax: 200,
  regionsMax: 4_096,
  opsPerBatchMax: 500,
  movesPerOpMax: 5_000,
} as const;

/** World ids are path-safe slugs (same rule as canvas ids in core). */
export const WORLD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
/** Node, edge and region ids. Allows `.` and `:` for namespaced ids. */
export const ENTITY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;

export const worldIdSchema = z.string().min(1).max(LIMITS.idMax)
  .regex(WORLD_ID_PATTERN, 'World ids may only contain letters, numbers, dashes and underscores.');

export const entityIdSchema = z.string().min(1).max(LIMITS.idMax)
  .regex(ENTITY_ID_PATTERN, 'Ids may only contain letters, numbers, and _ . : -');

export const NODE_KINDS = [
  'world',
  'region',
  'story',
  'book',
  'chapter',
  'scene',
  'character',
  'place',
  'faction',
  'artifact',
  'event',
  'house',
  'gate',
  'god',
  'godbeast',
  'concept',
  'note',
  'image',
] as const;
export const nodeKindSchema = z.enum(NODE_KINDS);
export type NodeKind = z.infer<typeof nodeKindSchema>;

export const RELATIONS = [
  'appears-in',
  'located-at',
  'precedes',
  'follows',
  'member-of',
  'bonded-to',
  'rules',
  'part-of',
  'references',
  'canon-of',
  'contradicts',
] as const;
export const relationSchema = z.enum(RELATIONS);
export type Relation = z.infer<typeof relationSchema>;

export const CANON_STATUSES = ['draft', 'proposed', 'canon'] as const;
export const canonStatusSchema = z.enum(CANON_STATUSES);
export type CanonStatus = z.infer<typeof canonStatusSchema>;

/**
 * Canon state of a node or edge. `canon` requires `ref`: a link to the merged
 * canon source in git (a PR or a file at a commit). Ops can never produce
 * `canon`; see ops.ts.
 */
export const canonSchema = z.object({
  status: canonStatusSchema,
  ref: z.url({ protocol: /^https?$/ }).optional(),
}).refine((value) => value.status !== 'canon' || Boolean(value.ref), {
  message: 'canon.status "canon" requires canon.ref (link to the merged canon source).',
  path: ['ref'],
});
export type Canon = z.infer<typeof canonSchema>;

export const DRAFT_CANON: Canon = Object.freeze({ status: 'draft' }) as Canon;

/**
 * Who made a change. `harness` is a lowercase slug such as `human`, `claude`,
 * `codex`, `chatgpt`, `gemini`, `importer`, `system`. The server stamps this
 * from the authenticated session; clients never supply it inside an op.
 */
export const KNOWN_HARNESSES = ['human', 'claude', 'codex', 'chatgpt', 'gemini', 'importer', 'system'] as const;
export const harnessSchema = z.string().min(1).max(64).regex(/^[a-z][a-z0-9-]*$/, 'harness must be a lowercase slug.');

export const actorSchema = z.object({
  harness: harnessSchema,
  at: z.iso.datetime(),
  /** Optional stable actor id (user id, agent session id). */
  actor: z.string().min(1).max(200).optional(),
});
export type Actor = z.infer<typeof actorSchema>;

export const positionSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
});
export type Position = z.infer<typeof positionSchema>;

export const sizeSchema = z.object({
  w: z.number().finite().positive(),
  h: z.number().finite().positive(),
});
export type Size = z.infer<typeof sizeSchema>;

export const boundsSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  w: z.number().finite().positive(),
  h: z.number().finite().positive(),
});
export type Bounds = z.infer<typeof boundsSchema>;

/**
 * A link a user can click: an absolute http(s) URL, or a relative path / R2
 * key resolved against the app's own origin. Executable schemes
 * (javascript:, data:, vbscript:, ...) are rejected here, in the shared
 * schema, so no consumer has to remember to filter them. Whitespace, control
 * characters and backslashes are rejected outright because browsers strip or
 * rewrite them in URLs ("java\tscript:" runs as "javascript:", "/\\host" is
 * "//host").
 */
export function isSafeLinkHref(value: string): boolean {
  if (value.length === 0 || value.length > 2048) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0020\u007f-\u009f\\]/.test(value)) return false;
  // Protocol-relative ("//host/x") is another origin, not a relative path.
  if (value.startsWith('//')) return false;
  // A colon before the first / ? # means the value has a scheme.
  const schemeEnd = value.search(/[/?#]/);
  const head = schemeEnd === -1 ? value : value.slice(0, schemeEnd);
  if (!head.includes(':')) return true;
  if (!/^https?:\/\//i.test(value)) return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname.length > 0;
  } catch {
    return false;
  }
}

export const safeLinkHrefSchema = z.string().refine(isSafeLinkHref, {
  message: 'href must be an http(s) URL or a relative path / R2 key.',
});

export const MEDIA_ROLES = ['cover', 'portrait', 'plate', 'illustration', 'reference', 'placeholder', 'attachment'] as const;
export const mediaRoleSchema = z.enum(MEDIA_ROLES);

/**
 * A media reference. Exactly where the bytes live:
 * - `r2Key`: object key in the world's R2 bucket (preferred once uploaded).
 * - `url`: an absolute http(s) URL.
 * - `originalSrc` + `needsReupload: true`: imported from a source whose asset
 *   store we cannot read (for example a claude.ai artifact `/_blob/...` path or
 *   an inline data URL). The bytes must be re-uploaded to R2.
 */
export const mediaSchema = z.object({
  r2Key: z.string().min(1).max(1024).optional(),
  url: z.url({ protocol: /^https?$/ }).optional(),
  alt: z.string().max(LIMITS.titleMax).default(''),
  role: mediaRoleSchema,
  /**
   * Where the media links to when clicked (source document, Figma frame).
   * An http(s) URL or a relative path / R2 key; see safeLinkHrefSchema.
   */
  href: safeLinkHrefSchema.optional(),
  originalSrc: z.string().min(1).max(100_000).optional(),
  needsReupload: z.boolean().optional(),
  width: z.number().finite().positive().optional(),
  height: z.number().finite().positive().optional(),
}).refine((m) => Boolean(m.r2Key || m.url || (m.needsReupload && m.originalSrc)), {
  message: 'media needs r2Key, url, or originalSrc with needsReupload: true.',
});
export type Media = z.infer<typeof mediaSchema>;

const tagsSchema = z.array(z.string().min(1).max(LIMITS.tagMax)).max(LIMITS.tagsMax);

export const worldNodeSchema = z.object({
  id: entityIdSchema,
  worldId: worldIdSchema,
  kind: nodeKindSchema,
  title: z.string().min(1).max(LIMITS.titleMax),
  summary: z.string().max(LIMITS.summaryMax).default(''),
  /** Markdown. */
  body: z.string().max(LIMITS.bodyMax).default(''),
  tags: tagsSchema.default([]),
  canon: canonSchema.default({ status: 'draft' }),
  media: z.array(mediaSchema).max(LIMITS.mediaMax).default([]),
  /** Top-left corner in world coordinates. */
  position: positionSchema,
  size: sizeSchema.optional(),
  /** Owning region, or null for world-root nodes. */
  regionId: entityIdSchema.nullable().default(null),
  /** Draw order; higher draws on top. */
  layer: z.number().int().min(-1000).max(1000).default(0),
  createdBy: actorSchema,
  updatedAt: z.iso.datetime(),
  /** Value of the world version counter at this node's last change. Never reused. */
  version: z.number().int().positive(),
  /** Free-form provenance and extension data. Not rendered as content. */
  meta: z.record(z.string(), z.unknown()).default({}),
});
export type WorldNode = z.infer<typeof worldNodeSchema>;

export const worldEdgeSchema = z.object({
  id: entityIdSchema,
  worldId: worldIdSchema,
  from: entityIdSchema,
  to: entityIdSchema,
  relation: relationSchema,
  label: z.string().min(1).max(LIMITS.labelMax).optional(),
  canon: canonSchema.default({ status: 'draft' }),
  createdBy: actorSchema,
  updatedAt: z.iso.datetime(),
  version: z.number().int().positive(),
  meta: z.record(z.string(), z.unknown()).default({}),
}).refine((edge) => edge.from !== edge.to, { message: 'Edges cannot connect a node to itself.', path: ['to'] });
export type WorldEdge = z.infer<typeof worldEdgeSchema>;

export const regionSchema = z.object({
  id: entityIdSchema,
  title: z.string().min(1).max(LIMITS.titleMax),
  bounds: boundsSchema,
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'color must be #rrggbb.').optional(),
});
export type Region = z.infer<typeof regionSchema>;

export const worldSchema = z.object({
  id: worldIdSchema,
  title: z.string().min(1).max(LIMITS.titleMax),
  summary: z.string().max(LIMITS.summaryMax).default(''),
  /** World-wide version counter: the highest version issued to any change. */
  version: z.number().int().nonnegative(),
  regions: z.array(regionSchema).max(LIMITS.regionsMax).default([]),
  updatedAt: z.iso.datetime(),
});
export type World = z.infer<typeof worldSchema>;

/** A full world document: the unit stored in git and exchanged as JSON. */
export const worldGraphSchema = z.object({
  schemaVersion: z.literal(WORLD_GRAPH_SCHEMA_VERSION),
  world: worldSchema,
  nodes: z.array(worldNodeSchema).default([]),
  edges: z.array(worldEdgeSchema).default([]),
});
export type WorldGraph = z.infer<typeof worldGraphSchema>;
export type WorldGraphInput = z.input<typeof worldGraphSchema>;
