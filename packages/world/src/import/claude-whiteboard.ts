import { z } from 'zod';
import { edgeIdFor, slugify, stableId } from '../ids.js';
import {
  nodeKindSchema,
  WORLD_GRAPH_SCHEMA_VERSION,
  type Actor,
  type Bounds,
  type Media,
  type NodeKind,
  type Region,
  type Relation,
  type WorldEdge,
  type WorldGraph,
  type WorldNode,
} from '../schemas.js';
import { validateWorldGraph } from '../validate.js';

/**
 * Importer for claude.ai whiteboard exports ("claude-whiteboard v1 elements").
 *
 * Input elements are shapes, texts, arrows and images with x, y, w, h, text,
 * size, color, from and to. The importer reads layout conventions, not names:
 *
 * - A `title`-size text like "III · THE TEN GATES" opens a section. Each
 *   section becomes a Region plus a `region` node. Elements belong to the
 *   nearest section header above and to the left of them. Elements with no
 *   header become the "Overview" region.
 * - A text like "01 · Foundation" is a gate heading. The line under it of the
 *   form "A × B" yields a god (A) and a godbeast (B); the next line is the
 *   gate's summary. Edges: god rules gate, god bonded-to godbeast, gate
 *   part-of the "<N> Gates" concept when one exists.
 * - A text like "Seven Houses: A, B, C." yields one `house` node per item,
 *   each part-of the "Seven Houses" concept when one exists.
 * - A short `large` text is a heading. The text directly under it becomes its
 *   summary. Kind comes from the lexicon, else from the section title
 *   ("story" sections hold characters), else `concept`.
 * - A bullet-list text yields one node per bullet.
 * - A small text directly under an image is its caption (title and alt). A
 *   text inside an image's box is the image's summary. A small text directly
 *   under a pill is the pill's summary.
 * - Pills (shapes with text) become `concept` nodes. Shapes without text are
 *   frames and are skipped.
 * - Images become `image` nodes. The original `src` is kept under
 *   `media[].originalSrc` with `needsReupload: true`. An image directly above
 *   or left of a heading gets an edge image references entity (label
 *   "depicts").
 * - Arrows become `precedes` edges.
 * - Any node whose text names another entity's title gets an edge
 *   `references` (label "mentions").
 *
 * Everything imported is canon.status "draft". Output is deterministic: the
 * same input and options produce byte-identical JSON.
 */

const elementSchema = z.looseObject({
  type: z.enum(['shape', 'text', 'arrow', 'image']),
  x: z.number().optional(),
  y: z.number().optional(),
  w: z.number().optional(),
  h: z.number().optional(),
  text: z.string().optional(),
  size: z.string().optional(),
  color: z.string().optional(),
  kind: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  src: z.string().optional(),
  href: z.string().optional(),
  wrap: z.number().optional(),
  locked: z.boolean().optional(),
  by: z.string().optional(),
});
type RawElement = z.infer<typeof elementSchema>;

export const claudeWhiteboardSchema = z.looseObject({
  source: z.string().optional(),
  title: z.string().optional(),
  exportedAt: z.string().optional(),
  format: z.string().optional(),
  elements: z.union([
    z.record(z.string(), elementSchema),
    z.array(elementSchema.extend({ id: z.string().min(1) })),
  ]),
});
export type ClaudeWhiteboard = z.infer<typeof claudeWhiteboardSchema>;

export interface ImportLexicon {
  /** Exact title (case-insensitive) to node kind, e.g. { "Nero": "god" }. */
  kinds?: Record<string, NodeKind>;
  /** Exact title (case-insensitive) to extra tags. */
  tags?: Record<string, string[]>;
}

export interface ImportOptions {
  /** World id. Defaults to a slug of the export title. */
  worldId?: string;
  /** World title. Defaults to the export title. */
  title?: string;
  /** Timestamp for createdBy/updatedAt. Defaults to exportedAt; required if exportedAt is missing. */
  at?: string;
  lexicon?: ImportLexicon;
}

export type ElementDisposition =
  | { as: 'node'; nodeId: string }
  | { as: 'merged'; into: string; role: string }
  | { as: 'expanded'; nodeIds: string[] }
  | { as: 'edge'; edgeId: string }
  | { as: 'region'; regionId: string; nodeId: string }
  | { as: 'skipped'; reason: string };

export interface ImportReport {
  source: { title: string; format?: string; exportedAt?: string };
  elementsIn: number;
  elementsByType: Record<string, number>;
  nodesOut: number;
  nodesByKind: Record<string, number>;
  edgesOut: number;
  edgesByRelation: Record<string, number>;
  regionsOut: number;
  dispositions: Record<ElementDisposition['as'], number>;
  needsReupload: number;
  skipped: { elementId: string; reason: string }[];
  warnings: string[];
}

export interface ImportResult {
  graph: WorldGraph;
  report: ImportReport;
  elements: Record<string, ElementDisposition>;
}

interface El extends RawElement {
  key: string;
}

const TEXT_METRICS: Record<string, { char: number; line: number }> = {
  title: { char: 26, line: 56 },
  large: { char: 13, line: 34 },
  body: { char: 8.5, line: 24 },
  small: { char: 7, line: 20 },
};

const ALIGN = 24;
const BELOW_GAP = 120;
const CAPTION_GAP = 40;
const DEPICT_GAP = 80;
const REGION_PAD = 48;

const SECTION_RE = /^([IVXLC]+)\s*[·.:]\s*(.+)$/;
const GATE_RE = /^(\d{1,2})\s*[·.:]\s*(.+)$/;
const PAIR_SPLIT_RE = /\s+[×x]\s+/;
const GROUP_LIST_RE = /^([^:\n]{1,60}?)\s*:\s*([^\n]+?)\.?$/;
const BULLET_RE = /^\s*[-*•]\s+(.+)$/;

const SMALL_WORDS = new Set(['a', 'an', 'and', 'as', 'at', 'by', 'for', 'in', 'of', 'on', 'or', 'the', 'to']);

function naturalKeyCompare(a: string, b: string): number {
  return a.localeCompare(b, 'en', { numeric: true });
}

function isAllCaps(text: string): boolean {
  return /[A-Z]/.test(text) && text === text.toUpperCase();
}

function titleCase(text: string): string {
  if (!isAllCaps(text)) return text.trim();
  return text.trim().toLowerCase().split(/\s+/).map((word, index) => {
    if (index > 0 && SMALL_WORDS.has(word)) return word;
    return word.charAt(0).toUpperCase() + word.slice(1);
  }).join(' ');
}

function clip(text: string, max: number): string {
  const clean = text.trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1).trimEnd()}…`;
}

function firstParagraph(text: string): string {
  return text.trim().split(/\n\s*\n/)[0]?.trim() ?? '';
}

function firstSentence(text: string): string {
  const para = firstParagraph(text).replace(/\s+/g, ' ');
  const match = para.match(/^(.+?[.!?])(\s|$)/);
  return match ? match[1] : para;
}

function textSize(el: El): { w: number; h: number } {
  const metrics = TEXT_METRICS[el.size ?? 'body'] ?? TEXT_METRICS.body;
  const text = el.text ?? '';
  const lines = text.split('\n');
  const longest = Math.max(1, ...lines.map((line) => line.length));
  const width = el.wrap ?? Math.min(1200, Math.max(80, Math.ceil(longest * metrics.char)));
  const perLine = Math.max(1, Math.floor(width / metrics.char));
  const lineCount = lines.reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / perLine)), 0);
  return { w: width, h: lineCount * metrics.line };
}

function elBox(el: El): Bounds {
  const x = el.x ?? 0;
  const y = el.y ?? 0;
  if (el.type === 'text') {
    const size = textSize(el);
    return { x, y, w: size.w, h: size.h };
  }
  return { x, y, w: Math.max(1, el.w ?? 1), h: Math.max(1, el.h ?? 1) };
}

function isHex6(color: string | undefined): color is string {
  return Boolean(color && /^#[0-9a-fA-F]{6}$/.test(color));
}

function safeUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function normalizeAt(options: ImportOptions, exportedAt: string | undefined): string {
  const candidate = options.at ?? exportedAt;
  if (!candidate) throw new Error('importClaudeWhiteboard: pass options.at; the export has no exportedAt.');
  if (/^\d{4}-\d{2}-\d{2}$/.test(candidate)) return `${candidate}T00:00:00.000Z`;
  const parsed = z.iso.datetime().safeParse(candidate);
  if (parsed.success) return candidate;
  const date = new Date(candidate);
  if (Number.isNaN(date.getTime())) throw new Error(`importClaudeWhiteboard: cannot read timestamp "${candidate}".`);
  return date.toISOString();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function countBy<T>(items: readonly T[], key: (item: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) out[key(item)] = (out[key(item)] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

export function importClaudeWhiteboard(input: unknown, options: ImportOptions = {}): ImportResult {
  const doc = claudeWhiteboardSchema.parse(input);
  const sourceTitle = doc.title?.trim() || 'Imported world';
  const worldTitle = options.title?.trim() || sourceTitle;
  const worldId = options.worldId ?? (slugify(worldTitle, 64) || 'world');
  const at = normalizeAt(options, doc.exportedAt);
  const actor: Actor = { harness: 'importer', at };
  const warnings: string[] = [];

  const lexKinds = new Map<string, NodeKind>();
  for (const [title, kind] of Object.entries(options.lexicon?.kinds ?? {})) {
    lexKinds.set(title.trim().toLowerCase(), nodeKindSchema.parse(kind));
  }
  const lexTags = new Map<string, string[]>();
  for (const [title, tags] of Object.entries(options.lexicon?.tags ?? {})) {
    lexTags.set(title.trim().toLowerCase(), tags);
  }

  const elements: El[] = (Array.isArray(doc.elements)
    ? doc.elements.map(({ id, ...rest }) => ({ ...rest, key: id }))
    : Object.entries(doc.elements).map(([key, value]) => ({ ...value, key }))
  ).sort((a, b) => naturalKeyCompare(a.key, b.key));
  const byKey = new Map(elements.map((el) => [el.key, el]));

  const disposition = new Map<string, ElementDisposition>();
  const consumed = (el: El) => disposition.has(el.key);

  const nodes: WorldNode[] = [];
  const nodeById = new Map<string, WorldNode>();
  const edges: WorldEdge[] = [];
  const edgeIds = new Set<string>();
  const regions: Region[] = [];
  /** Nodes that other text may "mention" (short proper titles). */
  const mentionable = new Set<string>();
  /** Heading element key to entity node id, for image "depicts" links. */
  const headingEntity = new Map<string, string>();

  const texts = elements.filter((el) => el.type === 'text' && typeof el.text === 'string' && el.text.trim());

  // ---------- 1. Frames ----------
  const positioned = elements.filter((el) => el.type !== 'arrow');
  for (const el of elements) {
    if (el.type === 'shape' && !el.text?.trim()) {
      const box = elBox(el);
      const contains = positioned.filter((other) => other !== el && other.x !== undefined && other.y !== undefined
        && other.x >= box.x && other.y >= box.y && other.x <= box.x + box.w && other.y <= box.y + box.h).length;
      const isBackground = contains >= Math.max(10, positioned.length * 0.5);
      disposition.set(el.key, { as: 'skipped', reason: isBackground ? 'background frame' : 'frame without text' });
    }
  }

  // ---------- 2. Sections -> regions ----------
  const headers = texts.filter((el) => el.size === 'title' && SECTION_RE.test(el.text!.trim()));
  const sectionOf = (el: El): El | null => {
    if (el.x === undefined || el.y === undefined) return null;
    let best: El | null = null;
    for (const header of headers) {
      if ((header.y ?? 0) <= el.y + 8 && (header.x ?? 0) <= el.x + 8) {
        if (!best || (header.y ?? 0) > (best.y ?? 0) || ((header.y ?? 0) === (best.y ?? 0) && (header.x ?? 0) > (best.x ?? 0))) best = header;
      }
    }
    return best;
  };

  const regionMembers = new Map<string, El[]>();
  const OVERVIEW = '__overview__';
  for (const el of positioned) {
    const status = disposition.get(el.key);
    if (status?.as === 'skipped' && status.reason === 'background frame') continue;
    const header = sectionOf(el);
    const key = header?.key ?? OVERVIEW;
    if (!regionMembers.has(key)) regionMembers.set(key, []);
    regionMembers.get(key)!.push(el);
  }

  const regionIdByHeader = new Map<string, string>();
  const regionTitleById = new Map<string, string>();
  const elementRegion = new Map<string, string | null>();

  const buildRegion = (key: string, title: string, color: string | undefined, ordinal?: string) => {
    const members = regionMembers.get(key) ?? [];
    if (members.length === 0) return null;
    const boxes = members.map(elBox);
    const minX = Math.min(...boxes.map((b) => b.x)) - REGION_PAD;
    const minY = Math.min(...boxes.map((b) => b.y)) - REGION_PAD;
    const maxX = Math.max(...boxes.map((b) => b.x + b.w)) + REGION_PAD;
    const maxY = Math.max(...boxes.map((b) => b.y + b.h)) + REGION_PAD;
    const id = stableId('r', `${worldId}\u0000claude-whiteboard\u0000${key}`, title);
    const region: Region = {
      id,
      title,
      bounds: { x: minX, y: minY, w: maxX - minX, h: maxY - minY },
      ...(isHex6(color) ? { color: color.toLowerCase() } : {}),
    };
    regions.push(region);
    regionTitleById.set(id, title);
    for (const member of members) elementRegion.set(member.key, id);
    return { region, ordinal };
  };

  const overview = buildRegion(OVERVIEW, 'Overview', undefined);
  for (const header of headers) {
    const match = header.text!.trim().match(SECTION_RE)!;
    const built = buildRegion(header.key, titleCase(match[2]), header.color, match[1]);
    if (built) regionIdByHeader.set(header.key, built.region.id);
  }

  const regionIdOf = (el: El): string | null => elementRegion.get(el.key) ?? null;
  const regionTitleOf = (el: El): string => {
    const id = regionIdOf(el);
    return id ? regionTitleById.get(id) ?? '' : '';
  };

  // ---------- node and edge helpers ----------
  const addNode = (spec: {
    key: string;
    kind: NodeKind;
    title: string;
    summary?: string;
    body?: string;
    tags?: string[];
    media?: Media[];
    position: { x: number; y: number };
    size?: { w: number; h: number };
    regionId: string | null;
    layer?: number;
    elementIds: string[];
    extraMeta?: Record<string, unknown>;
    mentionable?: boolean;
  }): WorldNode => {
    const lower = spec.title.trim().toLowerCase();
    const tags = [...new Set([...(spec.tags ?? []), ...(lexTags.get(lower) ?? [])])];
    const node: WorldNode = {
      id: stableId('n', `${worldId}\u0000claude-whiteboard\u0000${spec.key}`, spec.title),
      worldId,
      kind: spec.kind,
      title: clip(spec.title, 300),
      summary: clip(spec.summary ?? '', 2000),
      body: spec.body ?? '',
      tags,
      canon: { status: 'draft' },
      media: spec.media ?? [],
      position: { x: spec.position.x, y: spec.position.y },
      ...(spec.size ? { size: { w: Math.max(1, Math.round(spec.size.w)), h: Math.max(1, Math.round(spec.size.h)) } } : {}),
      regionId: spec.regionId,
      layer: spec.layer ?? 0,
      createdBy: actor,
      updatedAt: at,
      version: 1,
      meta: {
        import: { source: 'claude-whiteboard', elementIds: spec.elementIds },
        ...(spec.extraMeta ?? {}),
      },
    };
    if (nodeById.has(node.id)) throw new Error(`importClaudeWhiteboard: id collision for ${node.id}`);
    nodes.push(node);
    nodeById.set(node.id, node);
    if (spec.mentionable) mentionable.add(node.id);
    return node;
  };

  const addEdge = (from: string, to: string, relation: Relation, label?: string, elementIds: string[] = []): WorldEdge | null => {
    if (from === to) return null;
    const id = edgeIdFor(worldId, from, relation, to);
    if (edgeIds.has(id)) return null;
    const edge: WorldEdge = {
      id,
      worldId,
      from,
      to,
      relation,
      ...(label ? { label } : {}),
      canon: { status: 'draft' },
      createdBy: actor,
      updatedAt: at,
      version: 1,
      meta: elementIds.length ? { import: { source: 'claude-whiteboard', elementIds } } : {},
    };
    edges.push(edge);
    edgeIds.add(id);
    return edge;
  };

  const kindFor = (title: string, fallback: NodeKind, el?: El): NodeKind => {
    const lex = lexKinds.get(title.trim().toLowerCase());
    if (lex) return lex;
    if (el) {
      const section = regionTitleOf(el);
      if (/\b(story|cast|characters?)\b/i.test(section)) return 'character';
      if (/\b(places?|locations?|map|geography)\b/i.test(section)) return 'place';
      if (/\bfactions?\b/i.test(section)) return 'faction';
    }
    return fallback;
  };

  const findBelow = (anchor: El, maxGap = BELOW_GAP, filter: (el: El) => boolean = () => true): El | null => {
    let best: El | null = null;
    for (const el of texts) {
      if (el === anchor || consumed(el) || !filter(el)) continue;
      const dy = (el.y ?? 0) - (anchor.y ?? 0);
      if (Math.abs((el.x ?? 0) - (anchor.x ?? 0)) <= ALIGN && dy > 0 && dy <= maxGap) {
        if (!best || (el.y ?? 0) < (best.y ?? 0)) best = el;
      }
    }
    return best;
  };

  const isHeadingText = (el: El): boolean => {
    const text = el.text?.trim() ?? '';
    return el.size === 'large' && !text.includes('\n') && text.length <= 40 && !/[.!?]$/.test(text);
  };

  // ---------- 3. Region nodes + world node ----------
  for (const header of headers) {
    const regionId = regionIdByHeader.get(header.key);
    if (!regionId) continue;
    const match = header.text!.trim().match(SECTION_RE)!;
    const node = addNode({
      key: header.key,
      kind: 'region',
      title: titleCase(match[2]),
      tags: ['section'],
      position: { x: header.x ?? 0, y: header.y ?? 0 },
      size: textSize(header),
      regionId,
      layer: 1,
      elementIds: [header.key],
      extraMeta: { section: { ordinal: match[1] } },
    });
    disposition.set(header.key, { as: 'region', regionId, nodeId: node.id });
  }

  const overviewTitle = texts.find((el) => !consumed(el) && el.size === 'title' && regionIdOf(el) === (overview?.region.id ?? null));
  const worldAnchor = overviewTitle
    ? { x: overviewTitle.x ?? 0, y: overviewTitle.y ?? 0 }
    : { x: (overview?.region.bounds.x ?? -REGION_PAD) + REGION_PAD, y: (overview?.region.bounds.y ?? -REGION_PAD) + REGION_PAD };
  const worldNode = addNode({
    key: '__world__',
    kind: 'world',
    title: worldTitle,
    summary: overviewTitle?.text?.trim() ?? '',
    tags: ['world'],
    position: worldAnchor,
    size: overviewTitle ? textSize(overviewTitle) : { w: 480, h: 160 },
    regionId: overview?.region.id ?? null,
    layer: 2,
    elementIds: overviewTitle ? [overviewTitle.key] : [],
  });
  if (overviewTitle) disposition.set(overviewTitle.key, { as: 'merged', into: worldNode.id, role: 'world summary' });
  for (const header of headers) {
    const status = disposition.get(header.key);
    if (status?.as === 'region') addEdge(status.nodeId, worldNode.id, 'part-of');
  }

  // ---------- 4. Pills (shapes with text) ----------
  const pills = elements.filter((el) => el.type === 'shape' && el.text?.trim());
  const pillNodes = new Map<string, WorldNode>();
  for (const pill of pills) {
    const box = elBox(pill);
    const caption = texts.find((el) => !consumed(el) && (el.size === 'small' || el.size === 'body')
      && Math.abs((el.x ?? 0) - box.x) <= ALIGN && (el.y ?? 0) - (box.y + box.h) >= 0 && (el.y ?? 0) - (box.y + box.h) <= CAPTION_GAP);
    const title = pill.text!.trim();
    const node = addNode({
      key: pill.key,
      kind: kindFor(title, 'concept'),
      title,
      summary: caption?.text?.trim() ?? '',
      position: { x: box.x, y: box.y },
      size: { w: box.w, h: box.h },
      regionId: regionIdOf(pill),
      elementIds: caption ? [pill.key, caption.key] : [pill.key],
      mentionable: true,
    });
    pillNodes.set(pill.key, node);
    disposition.set(pill.key, { as: 'node', nodeId: node.id });
    if (caption) disposition.set(caption.key, { as: 'merged', into: node.id, role: 'caption' });
  }

  const findGroupConcept = (pattern: RegExp): WorldNode | undefined =>
    nodes.find((node) => node.kind === 'concept' && pattern.test(node.title));

  // ---------- 5. Gates ----------
  const gateHeadings = texts.filter((el) => !consumed(el) && el.size === 'large' && GATE_RE.test(el.text!.trim()));
  const gatesGroup = findGroupConcept(/^\S+\s+gates$/i);
  for (const heading of gateHeadings) {
    const match = heading.text!.trim().match(GATE_RE)!;
    const number = Number(match[1]);
    const gateName = match[2].trim();
    const pair = findBelow(heading, BELOW_GAP, (el) => !GATE_RE.test(el.text!.trim()));
    let domain: El | null = null;
    let names: string[] = [];
    if (pair) {
      const text = pair.text!.trim();
      if (PAIR_SPLIT_RE.test(text)) names = text.split(PAIR_SPLIT_RE).map((part) => part.trim()).filter(Boolean);
      else if (text.length <= 40 && !/[.!?]$/.test(text)) names = [text];
    }
    if (names.length > 0 && pair) {
      domain = findBelow(pair, BELOW_GAP, (el) => !GATE_RE.test(el.text!.trim()) && !isHeadingText(el));
    } else {
      domain = pair;
    }
    const regionId = regionIdOf(heading);
    const gate = addNode({
      key: heading.key,
      kind: 'gate',
      title: `${gateName} Gate`,
      summary: domain?.text?.trim() ?? '',
      tags: ['gate', `gate-${String(number).padStart(2, '0')}`],
      position: { x: heading.x ?? 0, y: heading.y ?? 0 },
      size: { w: heading.wrap ?? 430, h: 140 },
      regionId,
      elementIds: [heading.key, ...(domain ? [domain.key] : [])],
      extraMeta: { gate: { number, name: gateName } },
      mentionable: true,
    });
    disposition.set(heading.key, { as: 'node', nodeId: gate.id });
    headingEntity.set(heading.key, gate.id);
    if (domain) disposition.set(domain.key, { as: 'merged', into: gate.id, role: 'gate summary' });
    if (gatesGroup) addEdge(gate.id, gatesGroup.id, 'part-of');

    if (pair && names.length > 0) {
      const created: string[] = [];
      const [godName, beastName] = names;
      const god = addNode({
        key: `${pair.key}#god`,
        kind: kindFor(godName, 'god'),
        title: godName,
        tags: ['gate-god'],
        position: { x: pair.x ?? 0, y: (pair.y ?? 0) },
        size: { w: 200, h: 56 },
        regionId,
        elementIds: [pair.key],
        mentionable: true,
      });
      created.push(god.id);
      addEdge(god.id, gate.id, 'rules');
      if (beastName) {
        const beast = addNode({
          key: `${pair.key}#godbeast`,
          kind: kindFor(beastName, 'godbeast'),
          title: beastName,
          tags: ['godbeast'],
          position: { x: (pair.x ?? 0) + 220, y: pair.y ?? 0 },
          size: { w: 200, h: 56 },
          regionId,
          elementIds: [pair.key],
          mentionable: true,
        });
        created.push(beast.id);
        addEdge(god.id, beast.id, 'bonded-to');
      } else {
        warnings.push(`Gate "${gateName}" (${heading.key}) lists a god but no godbeast.`);
      }
      disposition.set(pair.key, { as: 'expanded', nodeIds: created });
    } else {
      warnings.push(`Gate "${gateName}" (${heading.key}) has no "God × Godbeast" line.`);
    }
  }

  // ---------- 6. Group lists ("Seven Houses: A, B, C.") ----------
  for (const el of texts) {
    if (consumed(el)) continue;
    const text = el.text!.trim();
    const match = text.match(GROUP_LIST_RE);
    if (!match || !/\bhouses?$/i.test(match[1].trim())) continue;
    const items = match[2].split(',').map((item) => item.trim()).filter(Boolean);
    if (items.length < 2) continue;
    const label = match[1].trim();
    const group = findGroupConcept(new RegExp(`^${escapeRegExp(label)}$`, 'i'));
    const created: string[] = [];
    items.forEach((item, index) => {
      const title = /^house\b/i.test(item) ? item : `House ${item}`;
      const col = index % 4;
      const row = Math.floor(index / 4);
      const house = addNode({
        key: `${el.key}#${index}`,
        kind: kindFor(title, 'house'),
        title,
        tags: ['house'],
        position: { x: (el.x ?? 0) + col * 176, y: (el.y ?? 0) + 64 + row * 72 },
        size: { w: 160, h: 56 },
        regionId: regionIdOf(el),
        elementIds: [el.key],
        mentionable: true,
      });
      created.push(house.id);
      if (group) addEdge(house.id, group.id, 'part-of');
    });
    if (!group) warnings.push(`List "${label}" (${el.key}) has no matching group concept; houses are unlinked.`);
    disposition.set(el.key, { as: 'expanded', nodeIds: created });
  }

  // ---------- 7. Images: captions and contained text ----------
  const images = elements.filter((el) => el.type === 'image');
  const imageCaption = new Map<string, El>();
  const imageInner = new Map<string, El[]>();
  for (const img of images) {
    const box = elBox(img);
    const caption = texts.find((el) => !consumed(el) && !isHeadingText(el) && (el.size === 'small' || el.size === 'body')
      && Math.abs((el.x ?? 0) - box.x) <= ALIGN && (el.y ?? 0) - (box.y + box.h) >= 0 && (el.y ?? 0) - (box.y + box.h) <= CAPTION_GAP);
    if (caption) {
      imageCaption.set(img.key, caption);
      disposition.set(caption.key, { as: 'skipped', reason: 'pending caption' });
    }
    const inner = texts.filter((el) => !consumed(el) && (el.x ?? 0) >= box.x && (el.x ?? 0) <= box.x + box.w
      && (el.y ?? 0) >= box.y && (el.y ?? 0) <= box.y + box.h);
    if (inner.length) {
      imageInner.set(img.key, inner);
      for (const el of inner) disposition.set(el.key, { as: 'skipped', reason: 'pending inner text' });
    }
  }

  // ---------- 8. Headings + summary ----------
  for (const heading of texts) {
    if (consumed(heading) || !isHeadingText(heading)) continue;
    const title = titleCase(heading.text!);
    const below = findBelow(heading, BELOW_GAP, (el) => !isHeadingText(el));
    const belowText = below?.text?.trim() ?? '';
    const multi = /\n\s*\n/.test(belowText);
    const node = addNode({
      key: heading.key,
      kind: kindFor(title, 'concept', heading),
      title,
      summary: multi ? firstParagraph(belowText) : belowText,
      body: multi ? belowText : '',
      position: { x: heading.x ?? 0, y: heading.y ?? 0 },
      size: { w: below?.wrap ?? heading.wrap ?? 330, h: 40 + (below ? textSize(below).h : 0) },
      regionId: regionIdOf(heading),
      elementIds: below ? [heading.key, below.key] : [heading.key],
      mentionable: true,
    });
    disposition.set(heading.key, { as: 'node', nodeId: node.id });
    headingEntity.set(heading.key, node.id);
    if (below) disposition.set(below.key, { as: 'merged', into: node.id, role: 'summary' });
  }

  // ---------- 9. Bullet lists ----------
  for (const el of texts) {
    if (consumed(el)) continue;
    const lines = el.text!.split('\n').map((line) => line.trim()).filter(Boolean);
    if (lines.length < 2 || !lines.every((line) => BULLET_RE.test(line))) continue;
    const created: string[] = [];
    lines.forEach((line, index) => {
      const title = line.match(BULLET_RE)![1].trim();
      const node = addNode({
        key: `${el.key}#${index}`,
        kind: kindFor(title, 'concept', el),
        title,
        position: { x: el.x ?? 0, y: (el.y ?? 0) + index * 44 },
        size: { w: el.wrap ?? 320, h: 36 },
        regionId: regionIdOf(el),
        elementIds: [el.key],
        mentionable: true,
      });
      created.push(node.id);
    });
    disposition.set(el.key, { as: 'expanded', nodeIds: created });
  }

  // ---------- 10. Remaining free text ----------
  for (const el of texts) {
    if (consumed(el)) continue;
    const text = el.text!.trim();
    const big = el.size === 'title' || el.size === 'large';
    const sentence = firstSentence(text);
    const title = clip(sentence.length < 32 ? firstParagraph(text).replace(/\s+/g, ' ') : sentence, 80);
    const node = addNode({
      key: el.key,
      kind: kindFor(text, big ? 'concept' : 'note'),
      title,
      summary: firstParagraph(text),
      body: text.includes('\n') ? text : '',
      tags: big ? [] : ['note'],
      position: { x: el.x ?? 0, y: el.y ?? 0 },
      size: textSize(el),
      regionId: regionIdOf(el),
      elementIds: [el.key],
    });
    disposition.set(el.key, { as: 'node', nodeId: node.id });
  }

  // ---------- 11. Image nodes ----------
  const headingEls = [...headingEntity.keys()].map((key) => byKey.get(key)!).filter(Boolean);
  let reupload = 0;
  for (const img of images) {
    const box = elBox(img);
    let depicted: string | undefined;
    for (const heading of headingEls) {
      const hx = heading.x ?? 0;
      const hy = heading.y ?? 0;
      const below = Math.abs(hx - box.x) <= ALIGN && hy - (box.y + box.h) >= 0 && hy - (box.y + box.h) <= DEPICT_GAP;
      const right = hx - (box.x + box.w) >= 0 && hx - (box.x + box.w) <= DEPICT_GAP && Math.abs(hy - box.y) <= 40;
      if (below || right) {
        depicted = headingEntity.get(heading.key);
        break;
      }
    }
    const depictedNode = depicted ? nodeById.get(depicted) : undefined;
    const caption = imageCaption.get(img.key);
    const inner = imageInner.get(img.key) ?? [];
    const isPlaceholder = (img.src ?? '').startsWith('data:');
    const regionId = regionIdOf(img);
    const role: Media['role'] = isPlaceholder
      ? 'placeholder'
      : depictedNode?.kind === 'character'
        ? 'portrait'
        : depictedNode
          ? 'plate'
          : regionId && regionId === overview?.region.id
            ? 'cover'
            : 'reference';
    const title = caption?.text?.trim()
      || (depictedNode
        ? `${depictedNode.title} ${isPlaceholder ? 'placeholder' : 'plate'}`
        : role === 'cover' ? `${worldTitle} cover` : `${regionTitleOf(img) || worldTitle} image`);
    const href = safeUrl(img.href);
    if (img.href && !href) warnings.push(`Image ${img.key} has a non-http href; kept in meta only.`);
    const media: Media[] = [];
    if (img.src) {
      media.push({
        alt: clip(title, 300),
        role,
        originalSrc: img.src,
        needsReupload: true,
        ...(href ? { href } : {}),
        ...(img.w ? { width: img.w } : {}),
        ...(img.h ? { height: img.h } : {}),
      });
      reupload++;
    } else {
      warnings.push(`Image ${img.key} has no src.`);
    }
    const node = addNode({
      key: img.key,
      kind: 'image',
      title,
      summary: inner.map((el) => el.text!.trim()).join('\n'),
      tags: isPlaceholder ? ['image', 'placeholder'] : ['image'],
      media,
      position: { x: box.x, y: box.y },
      size: { w: box.w, h: box.h },
      regionId,
      layer: -1,
      elementIds: [img.key, ...(caption ? [caption.key] : []), ...inner.map((el) => el.key)],
      extraMeta: {
        ...(img.by ? { generatedBy: img.by } : {}),
        ...(img.href && !href ? { originalHref: img.href } : {}),
      },
    });
    disposition.set(img.key, { as: 'node', nodeId: node.id });
    if (caption) disposition.set(caption.key, { as: 'merged', into: node.id, role: 'caption' });
    for (const el of inner) disposition.set(el.key, { as: 'merged', into: node.id, role: 'inner text' });
    if (depicted) addEdge(node.id, depicted, 'references', 'depicts');
  }

  // ---------- 12. Arrows ----------
  const nodeForElement = (key: string | undefined): string | undefined => {
    if (!key) return undefined;
    const status = disposition.get(key);
    if (status?.as === 'node') return status.nodeId;
    if (status?.as === 'merged') return status.into;
    if (status?.as === 'region') return status.nodeId;
    return undefined;
  };
  for (const arrow of elements.filter((el) => el.type === 'arrow')) {
    const from = nodeForElement(arrow.from);
    const to = nodeForElement(arrow.to);
    if (!from || !to) {
      disposition.set(arrow.key, { as: 'skipped', reason: `arrow endpoint not imported (${arrow.from ?? '?'} -> ${arrow.to ?? '?'})` });
      continue;
    }
    const edge = addEdge(from, to, 'precedes', arrow.text?.trim() || undefined, [arrow.key]);
    if (edge) disposition.set(arrow.key, { as: 'edge', edgeId: edge.id });
    else disposition.set(arrow.key, { as: 'skipped', reason: 'duplicate or self-referencing arrow' });
  }

  // ---------- 13. Mentions ----------
  const connected = new Set(edges.flatMap((edge) => [`${edge.from}|${edge.to}`, `${edge.to}|${edge.from}`]));
  const targets = [...mentionable].map((id) => nodeById.get(id)!).filter((node) => node.title.length >= 3)
    .map((node) => ({ node, re: new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(node.title)}(?=$|[^\\p{L}\\p{N}])`, 'u') }));
  for (const source of nodes) {
    if (source.kind === 'image' || source.kind === 'region') continue;
    const text = `${source.summary}\n${source.body}`;
    if (!text.trim()) continue;
    for (const { node: target, re } of targets) {
      if (target.id === source.id || connected.has(`${source.id}|${target.id}`)) continue;
      if (re.test(text)) {
        addEdge(source.id, target.id, 'references', 'mentions');
        connected.add(`${source.id}|${target.id}`);
        connected.add(`${target.id}|${source.id}`);
      }
    }
  }

  // ---------- accounting ----------
  for (const el of elements) {
    const status = disposition.get(el.key);
    if (!status) {
      disposition.set(el.key, { as: 'skipped', reason: `unsupported ${el.type} element` });
    } else if (status.as === 'skipped' && status.reason.startsWith('pending')) {
      warnings.push(`Element ${el.key} was left pending; this is an importer bug.`);
    }
  }

  const graph: WorldGraph = {
    schemaVersion: WORLD_GRAPH_SCHEMA_VERSION,
    world: {
      id: worldId,
      title: worldTitle,
      summary: clip(worldNode.summary, 2000),
      version: 1,
      regions,
      updatedAt: at,
    },
    nodes,
    edges,
  };

  const validation = validateWorldGraph(graph);
  if (!validation.ok) {
    throw new Error(`importClaudeWhiteboard produced an invalid graph: ${validation.issues.slice(0, 3).map((issue) => issue.message).join('; ')}`);
  }

  const dispositionList = elements.map((el) => disposition.get(el.key)!);
  const dispositions = { node: 0, merged: 0, expanded: 0, edge: 0, region: 0, skipped: 0 } as Record<ElementDisposition['as'], number>;
  for (const status of dispositionList) dispositions[status.as]++;

  const report: ImportReport = {
    source: { title: sourceTitle, format: doc.format, exportedAt: doc.exportedAt },
    elementsIn: elements.length,
    elementsByType: countBy(elements, (el) => el.type),
    nodesOut: nodes.length,
    nodesByKind: countBy(nodes, (node) => node.kind),
    edgesOut: edges.length,
    edgesByRelation: countBy(edges, (edge) => edge.relation),
    regionsOut: regions.length,
    dispositions,
    needsReupload: reupload,
    skipped: elements.flatMap((el) => {
      const status = disposition.get(el.key)!;
      return status.as === 'skipped' ? [{ elementId: el.key, reason: status.reason }] : [];
    }),
    warnings,
  };

  return {
    graph: validation.graph,
    report,
    elements: Object.fromEntries(elements.map((el) => [el.key, disposition.get(el.key)!])),
  };
}
