import { promises as fsp, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { generateWorld } from '../generate-world';

describe('world files', () => {
  let dir: string;
  const fileOf = (id: string) => path.join(dir, `${id}.world.json`);
  const disk = (id: string) => JSON.parse(readFileSync(fileOf(id), 'utf8'));
  const titleOnDisk = (id: string, nodeId: string) => disk(id).nodes.find((n: { id: string }) => n.id === nodeId).title;

  beforeAll(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'world-files-'));
    for (const id of ['race', 'cold', 'other']) writeFileSync(fileOf(id), JSON.stringify(generateWorld({ nodes: 40, worldId: id })));
    process.env.STARLIGHT_WORLD_DIR = dir;
    process.env.STARLIGHT_WORLD_PERSIST = '1';
  });
  afterEach(() => vi.restoreAllMocks());

  it('serializes concurrent persisted batches so every acknowledged op is on disk', async () => {
    const { applyWorldOps } = await import('../world-files');
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        applyWorldOps('race', [{ op: 'updateNode', id: `n_gen_${i}`, baseVersion: 1, patch: { title: `Edited ${i}` } }], 'human'),
      ),
    );
    expect(results.every((r) => r.ok)).toBe(true);
    expect(disk('race').world.version).toBe(13);
    for (let i = 0; i < 12; i++) expect(titleOnDisk('race', `n_gen_${i}`)).toBe(`Edited ${i}`);
  });

  it('a slow cold read that started before a save cannot cache the older graph', async () => {
    const { applyWorldOps, readWorld } = await import('../world-files');
    // The first read of the file sees the old content but resolves late.
    const realRead = fsp.readFile.bind(fsp);
    let calls = 0;
    vi.spyOn(fsp, 'readFile').mockImplementation((async (...args: Parameters<typeof fsp.readFile>) => {
      const content = await realRead(...args);
      if (++calls === 1) await new Promise((r) => setTimeout(r, 80));
      return content;
    }) as typeof fsp.readFile);
    const coldGet = readWorld('cold');
    const save = applyWorldOps('cold', [{ op: 'updateNode', id: 'n_gen_1', baseVersion: 1, patch: { title: 'Acknowledged' } }], 'human');
    expect((await save).ok).toBe(true);
    await coldGet;
    vi.restoreAllMocks();
    // The next edit must build on the acknowledged change, not on the stale read.
    const next = await applyWorldOps('cold', [{ op: 'updateNode', id: 'n_gen_2', baseVersion: 1, patch: { title: 'Second' } }], 'human');
    expect(next.ok).toBe(true);
    expect(titleOnDisk('cold', 'n_gen_1')).toBe('Acknowledged');
    expect(titleOnDisk('cold', 'n_gen_2')).toBe('Second');
    expect((await readWorld('cold')).nodes.find((n) => n.id === 'n_gen_1')?.title).toBe('Acknowledged');
  });

  it('a write by another process is the base for the next batch, not overwritten', async () => {
    const { applyWorldOps, readWorld } = await import('../world-files');
    await readWorld('other');
    // Another process saves an edit: same file, new content and version.
    const external = disk('other');
    external.world.version = 2;
    const target = external.nodes.find((n: { id: string }) => n.id === 'n_gen_3');
    target.title = 'From another process';
    target.version = 2;
    writeFileSync(fileOf('other'), JSON.stringify(external));
    // A stale baseVersion against the other process's write is refused...
    const stale = await applyWorldOps('other', [{ op: 'updateNode', id: 'n_gen_3', baseVersion: 1, patch: { title: 'Clobber' } }], 'human');
    expect(stale.ok).toBe(false);
    // ...and an unrelated edit keeps it.
    const ok = await applyWorldOps('other', [{ op: 'updateNode', id: 'n_gen_4', baseVersion: 1, patch: { title: 'Mine' } }], 'human');
    expect(ok.ok).toBe(true);
    expect(titleOnDisk('other', 'n_gen_3')).toBe('From another process');
    expect(titleOnDisk('other', 'n_gen_4')).toBe('Mine');
    expect(disk('other').world.version).toBe(3);
  });

  it('writes through a temp file and leaves no lock or temp files behind', async () => {
    const { applyWorldOps } = await import('../world-files');
    expect((await applyWorldOps('race', [{ op: 'updateNode', id: 'n_gen_20', baseVersion: 1, patch: { title: 'Clean' } }], 'human')).ok).toBe(true);
    const leftovers = (await fsp.readdir(dir)).filter((f) => f.endsWith('.tmp') || f.endsWith('.lock'));
    expect(leftovers).toEqual([]);
  });
});
