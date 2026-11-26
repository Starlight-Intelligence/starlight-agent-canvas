-- WORLD_INDEX: cross-world index. The per-world Durable Object stays the
-- source of truth; every row here can be rebuilt from it.

CREATE TABLE IF NOT EXISTS worlds (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 0,
  node_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

-- One row per node (spec section 6): tile key and position for region
-- loading, title and summary for search.
CREATE TABLE IF NOT EXISTS world_nodes (
  world_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  tile_key TEXT NOT NULL,
  region_id TEXT,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  canon_status TEXT NOT NULL,
  version INTEGER NOT NULL,
  x REAL NOT NULL,
  y REAL NOT NULL,
  w REAL NOT NULL,
  h REAL NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (world_id, node_id)
);

CREATE INDEX IF NOT EXISTS world_nodes_tile ON world_nodes (world_id, tile_key);
CREATE INDEX IF NOT EXISTS world_nodes_region ON world_nodes (world_id, region_id);
CREATE INDEX IF NOT EXISTS world_nodes_kind ON world_nodes (world_id, kind);
CREATE INDEX IF NOT EXISTS world_nodes_title ON world_nodes (world_id, title);
