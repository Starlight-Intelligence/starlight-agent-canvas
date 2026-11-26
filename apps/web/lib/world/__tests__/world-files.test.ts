import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { generateWorld } from '../generate-world';

describe('world files', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'world-files-'));
    writeFileSync(path.join(dir, 'race.world.json'), JSON.stringify(generateWorld({ nodes: 40, worldId: 'race' })));
    process.env.STARLIGHT_WORLD_DIR = dir;
    process.env.STARLIGHT_WORLD_PERSIST = '1';
  });

  it('serializes concurrent persisted batches so every acknowledged op is on disk', async () => {
    const { applyWorldOps } = await import('../world-files');
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        applyWorldOps('race', [{ op: 'updateNode', id: `n_gen_${i}`, baseVersion: 1, patch: { title: `Edited ${i}` } }], 'human'),
      ),
    );
    expect(results.every((r) => r.ok)).toBe(true);
    const onDisk = JSON.parse(readFileSync(path.join(dir, 'race.world.json'), 'utf8'));
    expect(onDisk.world.version).toBe(13);
    for (let i = 0; i < 12; i++) expect(onDisk.nodes.find((n: { id: string }) => n.id === `n_gen_${i}`).title).toBe(`Edited ${i}`);
  });
});
