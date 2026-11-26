# World Canvas Spec: World Graph v1

Status: draft contract for lanes L1 (world model), L2 (Cloudflare runtime) and L3 (canvas UI). Tracking issue: #63.

Code: `packages/world` (`@starlight-agent-canvas/world`). The zod schemas in `packages/world/src/schemas.ts` are the source of truth. If this document and the code disagree, the code wins and this document is a bug.

## 1. Purpose

A world is one large graph of nodes (characters, places, gates, books, images, notes) and typed edges, laid out on a 2D canvas. People and agents (Claude, Codex, ChatGPT and others through MCP) edit the same graph. Canon stays in git; the canvas holds drafts and proposals.

## 2. Document format

A world is exchanged and stored in git as one JSON document:

```json
{
  "schemaVersion": "starlight.worldGraph.v1",
  "world": { "id": "arcanea", "title": "Arcanea", "summary": "", "version": 1, "regions": [], "updatedAt": "2026-11-25T00:00:00.000Z" },
  "nodes": [],
  "edges": []
}
```

Rules:

- `schemaVersion` is the literal `starlight.worldGraph.v1`. Only additive, optional fields may be added under v1. Anything else needs v2.
- All timestamps are ISO 8601 UTC datetimes.
- `world.version` is the graph revision. It goes up by 1 on every accepted op batch.
- `world.retiredVersion` (optional, default 0) is the highest version any removed node or edge reached. New nodes and edges start at `retiredVersion + 1`, so versions are never reused when an id is deleted and recreated, and a stale op cannot hit the replacement. Stores must persist it.

### 2.1 Ids

| Entity | Pattern | Example |
| --- | --- | --- |
| World | `^[A-Za-z0-9][A-Za-z0-9_-]*$`, max 128 | `arcanea` |
| Node, edge, region | `^[A-Za-z0-9][A-Za-z0-9_.:-]*$`, max 128 | `n_arion_0833jf26tji` |

Generated ids have the form `<prefix>_<slug>_<token>` or `<prefix>_<token>`, prefix `w`, `n`, `e` or `r`.

- `stableId(prefix, key, hint?)`: deterministic. The token is a 53-bit hash of `prefix` and `key`; the slug comes from `hint` and is cosmetic. Importers use it so the same source gives the same ids.
- `newId(prefix, hint?)`: random, from Web Crypto. Used for live edits.
- `edgeIdFor(worldId, from, relation, to)`: deterministic edge id. `addEdge` uses it when the client sends no id, so the same link added twice is a `DUPLICATE_ID`, not a second edge.

### 2.2 World

| Field | Type | Notes |
| --- | --- | --- |
| `id` | world id | |
| `title` | string 1..300 | |
| `summary` | string 0..2000 | default `""` |
| `version` | int >= 0 | graph revision |
| `regions` | Region[] | max 4096 |
| `updatedAt` | datetime | |

### 2.3 Region

| Field | Type | Notes |
| --- | --- | --- |
| `id` | entity id | |
| `title` | string 1..300 | |
| `bounds` | `{x, y, w, h}` | world units, `w` and `h` > 0 |
| `color` | `#rrggbb` | optional |

Regions are authored areas (sections of the map). They are not the loading unit; tiles are (section 6). v1 has no region ops; regions change through import or a world-level edit by the owner.

### 2.4 Node

| Field | Type | Notes |
| --- | --- | --- |
| `id` | entity id | |
| `worldId` | world id | must equal `world.id` |
| `kind` | NodeKind | see below |
| `title` | string 1..300 | |
| `summary` | string 0..2000 | plain text, default `""` |
| `body` | string 0..200000 | markdown, default `""` |
| `tags` | string[] | max 64 tags of 1..64 chars |
| `canon` | `{status, ref?}` | default `{status: "draft"}` |
| `media` | Media[] | max 32 |
| `position` | `{x, y}` | top-left, world units |
| `size` | `{w, h}` | optional |
| `regionId` | region id or null | default null (world root) |
| `layer` | int -1000..1000 | draw order, default 0 |
| `createdBy` | `{harness, at, actor?}` | stamped by the server |
| `updatedAt` | datetime | |
| `version` | int >= 1 | starts at `world.retiredVersion + 1` (1 in a fresh world), +1 on every accepted change |
| `meta` | object | provenance and extensions, not rendered as content |

NodeKind: `world`, `region`, `story`, `book`, `chapter`, `scene`, `character`, `place`, `faction`, `artifact`, `event`, `house`, `gate`, `god`, `godbeast`, `concept`, `note`, `image`.

`harness` is a lowercase slug. Known values: `human`, `claude`, `codex`, `chatgpt`, `gemini`, `importer`, `system`.

### 2.5 Media

| Field | Type | Notes |
| --- | --- | --- |
| `r2Key` | string | object key in the world's R2 bucket |
| `url` | http(s) URL | |
| `originalSrc` | string | source path we cannot fetch (claude.ai `/_blob/...`, data URL) |
| `needsReupload` | boolean | true when only `originalSrc` is known |
| `alt` | string | default `""` |
| `role` | `cover`, `portrait`, `plate`, `illustration`, `reference`, `placeholder`, `attachment` | |
| `href` | http(s) URL, relative path or R2 key | where the media links to (source doc, Figma frame). Other schemes (`javascript:`, `data:`, ...) are rejected by the schema |
| `width`, `height` | number > 0 | optional |

A media entry must have `r2Key`, or `url`, or `originalSrc` with `needsReupload: true`.

### 2.6 Edge

| Field | Type | Notes |
| --- | --- | --- |
| `id` | entity id | |
| `worldId` | world id | |
| `from`, `to` | node ids | must exist; `from != to` |
| `relation` | Relation | see below |
| `label` | string 1..200 | optional |
| `canon` | `{status, ref?}` | default draft |
| `createdBy` | actor | |
| `updatedAt` | datetime | |
| `version` | int >= 1 | |
| `meta` | object | |

Relation: `appears-in`, `located-at`, `precedes`, `follows`, `member-of`, `bonded-to`, `rules`, `part-of`, `references`, `canon-of`, `contradicts`.

Direction reads as a sentence: `god rules gate`, `character appears-in scene`, `house part-of concept`, `image references character` (label `depicts`).

### 2.7 Referential rules

`validateWorldGraph(input)` runs the schema and then checks: unique ids per entity type, every `worldId` equals `world.id`, every non-null `regionId` exists, every edge endpoint exists. It never throws. `parseWorldGraph` throws `WorldGraphValidationError`.

## 3. Canon gate

1. Canon lives in git. For Arcanea that is `arcanea-ai-app/.arcanea/lore/CANON_LOCKED.md` and the files it points to.
2. `canon.status` is one of `draft`, `proposed`, `canon`. `canon` requires `canon.ref`, a link to the merged canon source.
3. No op can produce `canon`. Add ops accept `draft` or `proposed` only. An op that carries `canon.status: "canon"` anywhere is rejected with `CANON_FORBIDDEN`.
4. Nodes and edges with status `canon` cannot be updated or removed through ops (`CANON_LOCKED`). A node with a canon edge cannot be removed. Canon nodes may be moved; layout is not canon.
5. `proposeCanon` sets status `proposed` and returns a `CanonProposal`. L2 turns each proposal into a draft PR against `arcanea-ai-app` and writes the PR URL back as `canon.ref` with a follow-up `proposeCanon` (same target, `ref` set).
6. Any content edit to a `proposed` node sets it back to `draft`, because the open PR no longer matches.
7. `promoteToCanon(graph, target, ref, actor)` is the only way to reach `canon`. It is a plain function, not an op, and requires an https `ref`. L2 calls it only from the git sync path after the canon PR merges. It must never be reachable from MCP tools or the browser.

## 4. Op protocol

Clients change a world only by sending a batch of ops. The server applies them with:

```ts
applyOps(graph: WorldGraph, ops: unknown[], { actor }: { actor: Actor }): ApplyResult
```

- Pure. The input graph is never mutated. Unchanged nodes and edges are shared with the result. Cost is O(nodes + edges + ops).
- Atomic. Every op applies, or none do and the original graph is returned.
- Ops are parsed with strict schemas. Unknown keys are rejected, not dropped, so `canon`, `version`, `createdBy` and `worldId` cannot be smuggled in.
- Identity and time come from `actor`, which the server builds from the authenticated session. `createdBy` on new entities and every `updatedAt` use it.
- Max 500 ops per batch; max 5000 moves per `moveNodes`.

### 4.1 Ops

| Op | Fields | Effect |
| --- | --- | --- |
| `addNode` | `node: {id, kind, title, position, summary?, body?, tags?, canon?, media?, size?, regionId?, layer?, meta?}` | new node at version 1 |
| `updateNode` | `id, baseVersion, patch: {kind?, title?, summary?, body?, tags?, media?, size? (null clears), regionId?, layer?, meta?}` | merge patch, version +1 |
| `moveNodes` | `moves: [{id, baseVersion, position, regionId?}]` | move each node, version +1 each |
| `removeNode` | `id, baseVersion` | remove node and its edges |
| `addEdge` | `edge: {from, to, relation, id?, label?, canon?, meta?}` | new edge at version 1 |
| `removeEdge` | `id, baseVersion` | remove edge |
| `proposeCanon` | `target: {type: "node" or "edge", id}, baseVersion, ref?, note?` | status to `proposed`, version +1 |

`baseVersion` is the version the client last saw. If it differs from the current version the batch fails with `STALE_VERSION`, including `expectedVersion` and `actualVersion`. The client re-reads and retries. Within a batch, versions chain: a second update to the same node uses the version produced by the first.

Ids for `addNode` are required. When an MCP caller omits one, L2 fills it with `newId('n', title)` before calling `applyOps`.

### 4.2 Result

Success:

```ts
{ ok: true, graph, applied, changed: { nodes, edges, removedNodes, removedEdges }, proposals: CanonProposal[] }
```

`proposals` reflects the final state of the batch: at most one entry per target, at the target's final version, and only for targets that still exist with `canon.status: "proposed"`. A proposal followed in the same batch by an edit (which resets the target to draft) or a remove is dropped. A patch key set to `undefined` counts as not changed.

Failure:

```ts
{ ok: false, graph /* unchanged input */, error: { code, message, opIndex?, id?, expectedVersion?, actualVersion? } }
```

Error codes: `INVALID_OP`, `INVALID_CONTEXT`, `NOT_FOUND`, `DUPLICATE_ID`, `STALE_VERSION`, `CANON_FORBIDDEN`, `CANON_LOCKED`, `INVALID_REFERENCE`.

L2 broadcasts `changed` (with the new entity versions) and the new `world.version` to every connected client after a successful batch.

## 5. Semantic zoom

`semanticZoomLevel(zoom)` is a pure function of the viewport zoom factor (1 = one world unit per screen pixel):

| Level | Zoom | Shows |
| --- | --- | --- |
| `cluster` | `zoom < 0.4` | regions, cluster counts, no node text |
| `card` | `0.4 <= zoom < 1.2` | title, kind, tags, thumbnail |
| `full` | `zoom >= 1.2` | summary, body, media |

Thresholds are exported as `SEMANTIC_ZOOM_THRESHOLDS`. Zoom must be finite and > 0, otherwise it throws `RangeError`.

## 6. Region loading for 100k+ nodes

The browser never loads a whole large world.

1. World space is cut into square tiles of `TILE_SIZE = 2048` world units. `tileKey({x, y})` is `"<floor(x/2048)>:<floor(y/2048)>"`. A node belongs to the tile containing its `position`.
2. L2 keeps a D1 index row per node: `(world_id, node_id, tile_key, region_id, kind, title, canon_status, version, x, y, w, h)` with an index on `(world_id, tile_key)`. The full node JSON lives in the world's Durable Object storage.
3. On viewport change the client computes `tileKeysForBounds(viewport padded by one tile)` and asks only for tiles it does not hold. At `cluster` level it asks for per-tile counts by kind instead of nodes.
4. Edges are returned with a tile when either endpoint is in the tile. The client keeps an LRU of tiles and drops tiles far outside the viewport.
5. Region outlines (`world.regions`, at most 4096) and the minimap always load in full; they are small.
6. Search (D1 full text plus Vectorize) returns node ids with positions so the client can jump and then load the tiles there.
7. Ops still go to the one Durable Object per world, which holds the authoritative graph and writes the D1 index after each batch.

Helpers in `packages/world/src/zoom.ts`: `tileKey`, `tileKeysForBounds`, `nodesInBounds`, `regionAt`, `boundsIntersect`.

## 7. Importer: claude.ai whiteboard

`importClaudeWhiteboard(input, { worldId?, title?, at?, lexicon? })` in `packages/world/src/import/claude-whiteboard.ts`. CLI:

```bash
pnpm world:import --in <whiteboard.json> --out <world.json> --world-id arcanea --lexicon <lexicon.json>
```

It reads layout, not names:

- A title text like `III · THE TEN GATES` opens a section. Each section becomes a Region and a `region` node. An element belongs to the nearest section header above and left of it. Elements with no header form the `Overview` region.
- `01 · Foundation` is a gate heading. The line under it, `A × B`, gives a `god` (A) and a `godbeast` (B); the next line is the gate summary. Edges: `god rules gate`, `god bonded-to godbeast`, `gate part-of <N> Gates` concept.
- `Seven Houses: A, B, C.` gives one `house` node per item, `part-of` the `Seven Houses` concept.
- A short large text is a heading; the text under it is its summary. Kind: lexicon, else section hint (a "story" section holds characters), else `concept`.
- Bullet lists give one node per bullet. Pills become `concept` nodes. Shapes without text are frames and are skipped.
- A small text under an image is its caption; text inside an image box is the image summary. Images become `image` nodes with `media[].originalSrc` and `needsReupload: true`. A `src` over 100,000 characters (the `originalSrc` cap) keeps the node without media, records `meta.oversizedSrc` (length, hash, prefix) and `meta.needsReupload: true`, and adds a report warning. A free text longer than the summary limit keeps its full text in `body` even without a newline. An image right above or left of a heading gets `image references entity` (label `depicts`).
- Arrows become `precedes` edges. A node whose text names another entity title gets `references` (label `mentions`).
- Everything imported is `canon.status: "draft"`, `createdBy.harness: "importer"`. Output is deterministic.

The report lists elements in by type, nodes and edges out by kind and relation, regions out, per-element dispositions (`node`, `merged`, `expanded`, `edge`, `region`, `skipped`) that always sum to the element count, images needing re-upload, and warnings.

World content does not live in this public repo. The Arcanea world and its lexicon are in the private `frankxai/arcanea-world-graph` repo under `worlds/`.

## 8. MCP tools for L2

All tools act on one world. Writes go through `applyOps`; none can set canon.

| Tool | Input | Output | Maps to |
| --- | --- | --- | --- |
| `get_world` | `worldId` | world record (title, version, regions), node and edge counts by kind | read |
| `get_region` | `worldId, regionId` or `bounds`, `level?` | nodes and edges in the region or bounds, at the given zoom level | read via tiles |
| `search` | `worldId, query, kinds?, limit?` | ranked `{id, kind, title, summary, position, regionId}` | D1 FTS + Vectorize |
| `add_node` | node input (id optional), `regionId?` | created node | `addNode` |
| `update_node` | `id, baseVersion, patch` | updated node | `updateNode` |
| `link` | `from, to, relation, label?` | created edge | `addEdge` |
| `move` | `moves: [{id, baseVersion, position, regionId?}]` | moved nodes | `moveNodes` |
| `propose_canon` | `target, baseVersion, note` | proposal and PR URL once opened | `proposeCanon` + PR to arcanea-ai-app |
| `layout_region` | `worldId, regionId, strategy` (`grid`, `layered`, `force`) | moves applied | computes positions, then `moveNodes` |
| `import_whiteboard` | whiteboard JSON, `lexicon?` | import report; writes a new world or a draft branch | `importClaudeWhiteboard` |

Not exposed as tools: `removeNode` and `removeEdge` stay UI-only in v1 because MCP tools here are non-destructive; `promoteToCanon` is git-sync only.

Every tool response includes the new `world.version`. Every write tool returns `STALE_VERSION` details on conflict so the agent can re-read and retry.
