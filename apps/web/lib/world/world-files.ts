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
 */
export function worldDir(): string {
  if (process.env.STARLIGHT_WORLD_DIR) return path.resolve(/* turbopackIgnore: true */ process.env.STARLIGHT_WORLD_DIR);
  return path.join(path.resolve(/* turbopackIgnore: true */ getAgentCanvasHome()), 'worlds');
}

const cache = new Map<string, WorldGraph>();

export class WorldNotFoundError extends Error {}

export function isValidWorldId(worldId: string): boolean {
  return worldId.length <= 128 && WORLD_ID_PATTERN.test(worldId);
}

function fileFor(worldId: string): string {
  if (!isValidWorldId(worldId)) throw new WorldNotFoundError(`Invalid world id: ${worldId}`);
  return path.join(worldDir(), `${worldId}.world.json`);
}

export async function readWorld(worldId: string): Promise<WorldGraph> {
  const hit = cache.get(worldId);
  if (hit) return hit;
  const file = fileFor(worldId);
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    throw new WorldNotFoundError(`No world file for "${worldId}". Put ${worldId}.world.json in ${worldDir()} or set STARLIGHT_WORLD_DIR.`);
  }
  const graph = parseWorldGraph(JSON.parse(raw));
  cache.set(worldId, graph);
  return graph;
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

let tmpSeq = 0;

/**
 * Read, apply and write as one transaction per world. The cached graph is
 * replaced only after the write succeeds, so a failed write leaves the server
 * agreeing with the browser that rolled back.
 */
export function applyWorldOps(worldId: string, ops: unknown[], harness: string): Promise<ApplyResult> {
  return serialized(worldId, async () => {
    const graph = await readWorld(worldId);
    const safeHarness = /^[a-z][a-z0-9-]{0,63}$/.test(harness) ? harness : 'human';
    const result = applyOps(graph, ops, { actor: { harness: safeHarness, at: new Date().toISOString() } });
    if (!result.ok) return result;
    if (process.env.STARLIGHT_WORLD_PERSIST === '1') {
      const file = fileFor(worldId);
      const tmp = `${file}.${process.pid}.${++tmpSeq}.tmp`;
      await fs.writeFile(tmp, `${JSON.stringify(result.graph, null, 2)}\n`, 'utf8');
      await fs.rename(tmp, file);
    }
    cache.set(worldId, result.graph);
    return result;
  });
}
