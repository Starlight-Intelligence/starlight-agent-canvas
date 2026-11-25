import { parseWorldGraph } from '@starlight-agent-canvas/world';
import type { WorldGraph } from '@starlight-agent-canvas/world';
import { generateWorld } from './generate-world';
import { LocalWorldSource } from './local-source';
import { RemoteWorldSource } from './remote-source';
import type { WorldSource } from './source';

/** Which backend the canvas reads from. `remote` needs NEXT_PUBLIC_WORLD_WORKER_URL. */
export function worldSourceMode(): 'local' | 'remote' {
  return process.env.NEXT_PUBLIC_WORLD_SOURCE === 'remote' && process.env.NEXT_PUBLIC_WORLD_WORKER_URL ? 'remote' : 'local';
}

export async function createWorldSource(worldId: string): Promise<WorldSource> {
  if (worldSourceMode() === 'remote') {
    return new RemoteWorldSource(process.env.NEXT_PUBLIC_WORLD_WORKER_URL as string, worldId);
  }
  const res = await fetch(`/api/worlds/${encodeURIComponent(worldId)}`, { cache: 'no-store' });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Could not load world ${worldId} (HTTP ${res.status}).`);
  }
  const graph = parseWorldGraph(await res.json());
  return new LocalWorldSource(graph, { persistUrl: `/api/worlds/${encodeURIComponent(worldId)}/ops` });
}

export const STRESS_DEFAULT_NODES = 10_000;

export function createStressSource(nodes = STRESS_DEFAULT_NODES): LocalWorldSource {
  // Generated output is valid by construction (covered by a unit test), so the
  // zod parse is skipped here to keep first paint fast.
  const graph = generateWorld({ nodes }) as unknown as WorldGraph;
  return new LocalWorldSource(graph);
}
