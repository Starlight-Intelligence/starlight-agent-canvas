/**
 * Id helpers for World Graph v1.
 *
 * Runtime-neutral: no Node built-ins, so the same code runs in Node, browsers
 * and Cloudflare Workers.
 *
 * Id grammar: `<prefix>_<slug>_<hash>` or `<prefix>_<hash>`, matching
 * ENTITY_ID_PATTERN in schemas.ts.
 */

export type IdPrefix = 'w' | 'n' | 'e' | 'r';

const SLUG_MAX = 40;

export function slugify(value: string, max = SLUG_MAX): string {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
}

/**
 * cyrb53: a fast, well-distributed 53-bit string hash. Not cryptographic.
 * Used only to derive deterministic ids, never for security decisions.
 */
export function hash53(input: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

function hashToken(key: string): string {
  return hash53(key).toString(36).padStart(11, '0');
}

/**
 * Deterministic id: the same `key` always yields the same id. The optional
 * `hint` adds a readable slug but does not affect uniqueness, which comes
 * from the key alone. Importers use this so re-running an import on the same
 * source produces byte-identical output.
 */
export function stableId(prefix: IdPrefix, key: string, hint?: string): string {
  const slug = hint ? slugify(hint) : '';
  const token = hashToken(`${prefix}\u0000${key}`);
  return slug ? `${prefix}_${slug}_${token}` : `${prefix}_${token}`;
}

/**
 * Random id for entities created live (by people or agents). Uses Web Crypto,
 * which exists in Node 22+, browsers and Workers.
 */
export function newId(prefix: IdPrefix, hint?: string): string {
  const uuid = globalThis.crypto.randomUUID().replace(/-/g, '');
  const slug = hint ? slugify(hint) : '';
  const token = uuid.slice(0, 16);
  return slug ? `${prefix}_${slug}_${token}` : `${prefix}_${token}`;
}

/** Deterministic edge id from its endpoints and relation. */
export function edgeIdFor(worldId: string, from: string, relation: string, to: string): string {
  return stableId('e', `${worldId}\u0000${from}\u0000${relation}\u0000${to}`);
}
