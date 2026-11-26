import { promises as fs } from 'node:fs';
import path from 'node:path';
import { getAgentCanvasHome } from '@starlight-agent-canvas/core';
import { applyOps, parseWorldGraph, WORLD_ID_PATTERN } from '@starlight-agent-canvas/world';
import type { ApplyResult, WorldGraph } from '@starlight-agent-canvas/world';

/**
 * Local world files. World content is private (spec section 7), so nothing is
 * read from this repo: worlds come from STARLIGHT_WORLD_DIR, for example a
 * checkout of frankxai/arcanea-world-graph/worlds, or from `worlds/` under
 * AGENT_CANVAS_HOME (default ~/.starlight/agent-canvas/worlds).
 *
 * Edits apply to an in-process copy. They are written back to disk only when
 * STARLIGHT_WORLD_PERSIST=1, so pointing at a private checkout is read-only by default.
 *
 * Consistency rules:
 * - Every read and every write for a world runs on one per-world queue, so a
 *   slow cold read can never finish after a save and cache the older graph.
 * - When persisting, the file's identity (inode, size, mtime) is checked
 *   before each read is served and again under a lock file before each write.
 *   If another process changed the file, the batch is applied to the disk copy,
 *   so its baseVersion checks see that process's edits instead of erasing them.
 * - Writes go to a fresh temp file opened with 'wx', then rename over the target.
 */
export function worldDir(): string {
  if (process.env.STARLIGHT_WORLD_DIR) return path.resolve(/* turbopackIgnore: true */ process.env.STARLIGHT_WORLD_DIR);
  return path.join(path.resolve(/* turbopackIgnore: true */ getAgentCanvasHome()), 'worlds');
}

interface FileStamp {
  ino: number;
  size: number;
  mtimeMs: number;
}

interface CacheEntry {
  graph: WorldGraph;
  /** Identity of the file this graph was read from or last written to. */
  stamp: FileStamp | null;
}

const cache = new Map<string, CacheEntry>();

export class WorldNotFoundError extends Error {}

export function isValidWorldId(worldId: string): boolean {
  return worldId.length <= 128 && WORLD_ID_PATTERN.test(worldId);
}

function fileFor(worldId: string): string {
  if (!isValidWorldId(worldId)) throw new WorldNotFoundError(`Invalid world id: ${worldId}`);
  return path.join(worldDir(), `${worldId}.world.json`);
}

const persisting = () => process.env.STARLIGHT_WORLD_PERSIST === '1';

function sameStamp(a: FileStamp | null, b: FileStamp | null): boolean {
  return Boolean(a && b && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs);
}

async function stampOf(file: string): Promise<FileStamp | null> {
  try {
    const s = await fs.stat(file);
    return { ino: s.ino, size: s.size, mtimeMs: s.mtimeMs };
  } catch {
    return null;
  }
}

async function readFromDisk(worldId: string): Promise<CacheEntry> {
  const file = fileFor(worldId);
  let raw: string;
  let stamp: FileStamp | null;
  try {
    stamp = await stampOf(file);
    raw = await fs.readFile(file, 'utf8');
  } catch {
    throw new WorldNotFoundError(`No world file for "${worldId}". Put ${worldId}.world.json in ${worldDir()} or set STARLIGHT_WORLD_DIR.`);
  }
  return { graph: parseWorldGraph(JSON.parse(raw)), stamp };
}

/**
 * The current graph. Must run inside `serialized`. Without persistence the
 * in-process copy is authoritative once loaded (edits never reach the file).
 * With persistence, a file changed by another process is re-read.
 */
async function current(worldId: string): Promise<CacheEntry> {
  const hit = cache.get(worldId);
  if (hit && !persisting()) return hit;
  if (hit && sameStamp(hit.stamp, await stampOf(fileFor(worldId)))) return hit;
  const entry = await readFromDisk(worldId);
  cache.set(worldId, entry);
  return entry;
}

const queues = new Map<string, Promise<unknown>>();

/** Runs `task` after every earlier task for the same world has settled. */
function serialized<T>(worldId: string, task: () => Promise<T>): Promise<T> {
  const previous = queues.get(worldId) ?? Promise.resolve();
  const run = previous.then(task, task);
  const tail = run.catch(() => undefined);
  queues.set(worldId, tail);
  void tail.then(() => {
    if (queues.get(worldId) === tail) queues.delete(worldId);
  });
  return run;
}

export function readWorld(worldId: string): Promise<WorldGraph> {
  return serialized(worldId, async () => (await current(worldId)).graph);
}

const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 10_000;

/** Cross-process lock next to the world file: created with 'wx', removed after the write. */
async function withFileLock<T>(file: string, task: () => Promise<T>): Promise<T> {
  const lock = `${file}.lock`;
  const started = Date.now();
  for (;;) {
    try {
      const handle = await fs.open(lock, 'wx');
      await handle.writeFile(`${process.pid}\n`);
      await handle.close();
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const s = await fs.stat(lock).catch(() => null);
      if (s && Date.now() - s.mtimeMs > LOCK_STALE_MS) {
        await fs.unlink(lock).catch(() => undefined);
        continue;
      }
      if (Date.now() - started > LOCK_WAIT_MS) throw new Error(`World file is locked by another process: ${lock}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }
  try {
    return await task();
  } finally {
    await fs.unlink(lock).catch(() => undefined);
  }
}

let tmpSeq = 0;

/**
 * Read, apply and write as one transaction per world. The cached graph is
 * replaced only after the write succeeds, so a failed write leaves the server
 * agreeing with the browser that rolled back.
 */
export function applyWorldOps(worldId: string, ops: unknown[], harness: string): Promise<ApplyResult> {
  return serialized(worldId, async () => {
    const safeHarness = /^[a-z][a-z0-9-]{0,63}$/.test(harness) ? harness : 'human';
    const apply = (graph: WorldGraph) => applyOps(graph, ops, { actor: { harness: safeHarness, at: new Date().toISOString() } });
    if (!persisting()) {
      const result = apply((await current(worldId)).graph);
      if (result.ok) cache.set(worldId, { graph: result.graph, stamp: null });
      return result;
    }
    const file = fileFor(worldId);
    return withFileLock(file, async () => {
      // Under the lock, re-check the file so a write from another process is the base.
      const base = await current(worldId);
      const result = apply(base.graph);
      if (!result.ok) return result;
      const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.${++tmpSeq}.tmp`;
      try {
        await fs.writeFile(tmp, `${JSON.stringify(result.graph, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
        await fs.rename(tmp, file);
      } catch (error) {
        await fs.unlink(tmp).catch(() => undefined);
        throw error;
      }
      cache.set(worldId, { graph: result.graph, stamp: await stampOf(file) });
      return result;
    });
  });
}
