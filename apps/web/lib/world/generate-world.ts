// Deterministic world generator for the stress route and scripts/generate-world.mjs.
// No runtime imports and only erasable TypeScript, so Node can run it with type stripping.

export interface GenerateOptions {
  nodes: number;
  /** Extra edges per node on top of the region spine. */
  edgeRatio?: number;
  seed?: number;
  worldId?: string;
  at?: string;
}

const KINDS = ['character', 'place', 'gate', 'god', 'godbeast', 'house', 'story', 'book', 'chapter', 'event', 'image', 'note'] as const;
const RELATIONS_BY_KIND: Record<string, string> = {
  character: 'appears-in',
  place: 'part-of',
  gate: 'part-of',
  god: 'rules',
  godbeast: 'bonded-to',
  house: 'member-of',
  story: 'references',
  book: 'part-of',
  chapter: 'part-of',
  event: 'located-at',
  image: 'references',
  note: 'references',
};
const SYLLABLES = ['ar', 'el', 'ion', 'ka', 'mera', 'tho', 'lyn', 'vael', 'sor', 'dra', 'nyx', 'ost', 'ra', 'quil', 'ent', 'is', 'mor', 'una', 'cal', 'dor'];
const REGION_NAMES = [
  'Northern reach', 'Glass coast', 'Ember steppe', 'Tidewater', 'Hollow wood', 'Salt marsh', 'High court', 'Sunken library',
  'Ash fields', 'Mirror lakes', 'Old road', 'Starfall basin', 'Quiet isles', 'Copper hills', 'Veil gate', 'Long winter',
  'Bright harbor', 'Root halls', 'Far archive', 'Last light',
];
const TINTS = ['#6f9a8d', '#a3785c', '#5d86a0', '#9c8a5e', '#8f8a6a', '#7c8f5a', '#a06a6a', '#5f8f8a'];

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * A World Graph v1 document with `nodes` nodes spread over a grid of regions.
 * Same options give byte-identical output.
 */
export function generateWorld(options: GenerateOptions) {
  const n = Math.max(1, Math.floor(options.nodes));
  const rand = mulberry32(options.seed ?? 63);
  const worldId = options.worldId ?? 'stress';
  const at = options.at ?? '2026-11-25T00:00:00.000Z';
  const regionCount = Math.min(REGION_NAMES.length, Math.max(1, Math.ceil(n / 500)));
  const cols = Math.ceil(Math.sqrt(regionCount));
  const perRegion = Math.ceil(n / regionCount);
  const cellCols = Math.ceil(Math.sqrt(perRegion));
  const cellW = 300;
  const cellH = 200;
  const regionW = cellCols * cellW + 400;
  const regionH = Math.ceil(perRegion / cellCols) * cellH + 400;

  const regions = Array.from({ length: regionCount }, (_, i) => ({
    id: `r_gen_${i}`,
    title: REGION_NAMES[i],
    bounds: { x: (i % cols) * (regionW + 600), y: Math.floor(i / cols) * (regionH + 600), w: regionW, h: regionH },
    color: TINTS[i % TINTS.length],
  }));

  const harnesses = ['importer', 'claude', 'codex', 'human', 'chatgpt'];
  const nodes = [];
  for (let i = 0; i < n; i++) {
    const r = Math.floor(i / perRegion);
    const local = i % perRegion;
    const region = regions[Math.min(r, regions.length - 1)];
    const kind = KINDS[Math.floor(rand() * KINDS.length)];
    const name = cap(SYLLABLES[Math.floor(rand() * SYLLABLES.length)] + SYLLABLES[Math.floor(rand() * SYLLABLES.length)]);
    const jitterX = Math.floor(rand() * 40);
    const jitterY = Math.floor(rand() * 30);
    const roll = rand();
    nodes.push({
      id: `n_gen_${i}`,
      worldId,
      kind,
      title: `${name} ${kind === 'character' ? '' : kind}`.trim(),
      summary: `Generated ${kind} ${i} in ${region.title.toLowerCase()}.`,
      body: '',
      tags: [kind, `region-${r}`],
      canon: { status: roll < 0.05 ? 'proposed' : 'draft' },
      media: [],
      position: {
        x: region.bounds.x + 200 + (local % cellCols) * cellW + jitterX,
        y: region.bounds.y + 200 + Math.floor(local / cellCols) * cellH + jitterY,
      },
      size: { w: 240, h: kind === 'image' ? 150 : 96 },
      regionId: region.id,
      layer: 0,
      createdBy: { harness: harnesses[i % harnesses.length], at },
      updatedAt: at,
      version: 1,
      meta: { generated: true },
    });
  }

  const edges = [];
  const seen = new Set<string>();
  const ratio = options.edgeRatio ?? 1.5;
  const target = Math.floor(n * ratio);
  for (let k = 0; edges.length < target && k < target * 3; k++) {
    const a = Math.floor(rand() * n);
    // Mostly local links, so edges stay inside a region the way authored worlds do.
    const near = Math.floor(rand() * 40) - 20;
    const b = rand() < 0.9 ? Math.min(n - 1, Math.max(0, a + near)) : Math.floor(rand() * n);
    if (a === b) continue;
    const key = `${a}>${b}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({
      id: `e_gen_${edges.length}`,
      worldId,
      from: `n_gen_${a}`,
      to: `n_gen_${b}`,
      relation: RELATIONS_BY_KIND[nodes[a].kind] ?? 'references',
      canon: { status: 'draft' },
      createdBy: { harness: 'importer', at },
      updatedAt: at,
      version: 1,
      meta: {},
    });
  }

  return {
    schemaVersion: 'starlight.worldGraph.v1' as const,
    world: {
      id: worldId,
      title: `Stress world, ${n.toLocaleString('en-US')} nodes`,
      summary: 'Generated for performance testing.',
      version: 1,
      regions,
      updatedAt: at,
    },
    nodes,
    edges,
  };
}
