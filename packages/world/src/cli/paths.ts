import { realpathSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';

/**
 * Canonical form of a path for overlap checks: absolute, symlinks resolved
 * for the longest existing prefix, and lowercased on win32 (and darwin, whose
 * default file systems are case-insensitive too).
 */
export function canonicalPath(path: string, platform: NodeJS.Platform = process.platform): string {
  let absolute = resolve(path);
  const tail: string[] = [];
  let probe = absolute;
  for (;;) {
    try {
      absolute = resolve(realpathSync(probe), ...tail.reverse());
      break;
    } catch {
      const parent = dirname(probe);
      if (parent === probe) break;
      tail.push(basename(probe));
      probe = parent;
    }
  }
  return platform === 'win32' || platform === 'darwin' ? absolute.toLowerCase() : absolute;
}

/**
 * Pairs of named paths that point at the same file. The CLI refuses to run if
 * any input, lexicon, output or report path coincides, so it can never
 * overwrite its own source or replace the graph with the report.
 */
export function findPathOverlaps(
  paths: Record<string, string | undefined>,
  platform: NodeJS.Platform = process.platform,
): [string, string][] {
  const entries = Object.entries(paths).filter((entry): entry is [string, string] => Boolean(entry[1]));
  const canonical = entries.map(([name, path]) => [name, canonicalPath(path, platform)] as const);
  const overlaps: [string, string][] = [];
  for (let i = 0; i < canonical.length; i++) {
    for (let j = i + 1; j < canonical.length; j++) {
      if (canonical[i][1] === canonical[j][1]) overlaps.push([canonical[i][0], canonical[j][0]]);
    }
  }
  return overlaps;
}
