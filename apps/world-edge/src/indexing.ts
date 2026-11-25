import { tileKey, type World, type WorldNode } from '@starlight-agent-canvas/world';
import { sha256Hex } from './auth.js';
import type { Env } from './env.js';

/** Workers AI text embedding model; 768 dimensions, cosine metric. */
export const EMBEDDING_MODEL = '@cf/baai/bge-base-en-v1.5';
export const EMBEDDING_DIMENSIONS = 768;
const EMBED_BATCH = 50;

export interface SearchHit {
  id: string;
  kind: string;
  title: string;
  summary: string;
  position: { x: number; y: number };
  regionId: string | null;
  score?: number;
}

export type SearchMode = 'semantic' | 'd1-like' | 'do-like';

export function embeddingText(node: Pick<WorldNode, 'title' | 'summary'>): string {
  return node.summary ? `${node.title}\n${node.summary}` : node.title;
}

/** Vectorize ids are capped at 64 bytes; node ids may be 128. Hash them. */
export async function vectorId(worldId: string, nodeId: string): Promise<string> {
  return sha256Hex(`${worldId}\u0000${nodeId}`);
}

export function toHit(node: WorldNode, score?: number): SearchHit {
  return {
    id: node.id,
    kind: node.kind,
    title: node.title,
    summary: node.summary,
    position: node.position,
    regionId: node.regionId,
    ...(score !== undefined ? { score } : {}),
  };
}

/**
 * Mirror a committed batch into the cross-world index (D1) and the vector
 * index. Runs after the Durable Object has committed, through waitUntil, so a
 * slow index never blocks or fails a write. The DO stays authoritative; the
 * index can be rebuilt from it.
 */
export async function syncIndex(
  env: Env,
  world: Pick<World, 'id' | 'title' | 'summary' | 'version' | 'updatedAt'>,
  nodeCount: number,
  nodes: readonly WorldNode[],
  removedNodes: readonly string[],
): Promise<void> {
  if (env.WORLD_INDEX) {
    const db = env.WORLD_INDEX;
    const statements: D1PreparedStatement[] = [
      db.prepare(
        `INSERT INTO worlds (id, title, summary, version, node_count, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET title = excluded.title, summary = excluded.summary, version = excluded.version,
           node_count = excluded.node_count, updated_at = excluded.updated_at
         WHERE excluded.version >= worlds.version`,
      ).bind(world.id, world.title, world.summary, world.version, nodeCount, world.updatedAt),
    ];
    for (const node of nodes) {
      statements.push(db.prepare(
        `INSERT INTO world_nodes (world_id, node_id, tile_key, region_id, kind, title, summary, canon_status, version, x, y, w, h, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(world_id, node_id) DO UPDATE SET tile_key = excluded.tile_key, region_id = excluded.region_id,
           kind = excluded.kind, title = excluded.title, summary = excluded.summary, canon_status = excluded.canon_status,
           version = excluded.version, x = excluded.x, y = excluded.y, w = excluded.w, h = excluded.h, updated_at = excluded.updated_at
         WHERE excluded.version >= world_nodes.version`,
      ).bind(
        world.id, node.id, tileKey(node.position), node.regionId, node.kind, node.title, node.summary, node.canon.status,
        node.version, node.position.x, node.position.y, node.size?.w ?? 1, node.size?.h ?? 1, node.updatedAt,
      ));
    }
    for (const id of removedNodes) {
      statements.push(db.prepare('DELETE FROM world_nodes WHERE world_id = ? AND node_id = ?').bind(world.id, id));
    }
    // D1 batches run as one transaction; keep each batch bounded.
    for (let i = 0; i < statements.length; i += 100) await db.batch(statements.slice(i, i + 100));
  }

  if (env.WORLD_VECTORS && env.AI) {
    // Only nodes whose embedded text could have changed need new vectors.
    for (let i = 0; i < nodes.length; i += EMBED_BATCH) {
      const chunk = nodes.slice(i, i + EMBED_BATCH);
      const embedded = (await env.AI.run(EMBEDDING_MODEL, { text: chunk.map(embeddingText) })) as { data?: number[][] };
      const vectors: VectorizeVector[] = [];
      for (let j = 0; j < chunk.length; j++) {
        const values = embedded.data?.[j];
        if (!values) continue;
        const node = chunk[j]!;
        vectors.push({
          id: await vectorId(world.id, node.id),
          values,
          namespace: world.id,
          metadata: { worldId: world.id, nodeId: node.id, kind: node.kind },
        });
      }
      if (vectors.length > 0) await env.WORLD_VECTORS.upsert(vectors);
    }
    if (removedNodes.length > 0) {
      await env.WORLD_VECTORS.deleteByIds(await Promise.all(removedNodes.map((id) => vectorId(world.id, id))));
    }
  }
}

/** Semantic search. Returns null when the AI or Vectorize binding is missing. */
export async function semanticSearch(
  env: Env,
  worldId: string,
  query: string,
  topK: number,
  kinds?: readonly string[],
): Promise<{ nodeId: string; score: number }[] | null> {
  if (!env.WORLD_VECTORS || !env.AI) return null;
  const embedded = (await env.AI.run(EMBEDDING_MODEL, { text: [query] })) as { data?: number[][] };
  const vector = embedded.data?.[0];
  if (!vector) return null;
  // Filter by kind inside Vectorize (needs the metadata index on `kind`, see
  // README) so a kind-restricted search still gets topK matching candidates.
  const result = await env.WORLD_VECTORS.query(vector, {
    topK: Math.min(topK, 50),
    namespace: worldId,
    returnMetadata: 'all',
    ...(kinds && kinds.length > 0 ? { filter: { kind: { $in: [...kinds] } } } : {}),
  });
  return result.matches
    .map((m) => ({ nodeId: String((m.metadata as Record<string, unknown> | undefined)?.nodeId ?? ''), score: m.score }))
    .filter((m) => m.nodeId);
}

/** D1 LIKE search over the cross-world index. Returns null without the binding. */
export async function d1Search(
  env: Env,
  worldId: string,
  query: string,
  kinds: readonly string[] | undefined,
  limit: number,
): Promise<SearchHit[] | null> {
  if (!env.WORLD_INDEX) return null;
  const pattern = `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const kindsJson = kinds && kinds.length > 0 ? JSON.stringify(kinds) : null;
  const { results } = await env.WORLD_INDEX.prepare(
    `SELECT node_id, kind, title, summary, x, y, region_id FROM world_nodes
     WHERE world_id = ?1 AND (title LIKE ?2 ESCAPE '\\' OR summary LIKE ?2 ESCAPE '\\')
       AND (?3 IS NULL OR kind IN (SELECT value FROM json_each(?3)))
     ORDER BY CASE WHEN title LIKE ?2 ESCAPE '\\' THEN 0 ELSE 1 END, length(title), node_id
     LIMIT ?4`,
  ).bind(worldId, pattern, kindsJson, limit).all<Record<string, unknown>>();
  return results.map((r) => ({
    id: String(r.node_id),
    kind: String(r.kind),
    title: String(r.title),
    summary: String(r.summary ?? ''),
    position: { x: Number(r.x), y: Number(r.y) },
    regionId: r.region_id === null ? null : String(r.region_id),
  }));
}
