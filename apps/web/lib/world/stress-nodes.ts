export const STRESS_DEFAULT_NODES = 10_000;
export const STRESS_MAX_NODES = 100_000;

/** Parses `?nodes=`: whole numbers only (floored first), clamped to 1..100k, 10k by default. */
export function parseStressNodes(value: string | undefined): number {
  const n = Math.floor(Number(value) || STRESS_DEFAULT_NODES);
  return Math.min(STRESS_MAX_NODES, Math.max(1, n));
}
