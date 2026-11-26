# World canvas UI (lane L3)

Routes in `apps/web`:

- `/world/[worldId]` opens a World Graph v1 document.
- `/world/stress` opens a generated world of 10,000 nodes. `?nodes=` changes the count, up to 100,000.

Deep-link parameters: `?node=<id>` selects a node and opens it at full zoom, `?at=x,y` centers a point, `?region=<id or title>` fits a region, `?zoom=` sets the zoom, `?view=graph|timeline|map` picks the view.

Design rules are in `docs/design/world-canvas/design-lock.md`.

## Data

The canvas reads and writes only through `WorldSource` (`apps/web/lib/world/source.ts`):

- `LocalWorldSource` holds a world in memory and serves tile queries from a spatial index. Worlds load from `GET /api/worlds/[worldId]`, which reads `<worldId>.world.json` from `STARLIGHT_WORLD_DIR`, or else from `$AGENT_CANVAS_HOME/worlds` (default `~/.starlight/agent-canvas/worlds`). World content stays out of this repo, as spec section 7 requires.
- Edits are GraphOp batches. The source applies them right away through `applyOps` with `baseVersion`, then posts them to `POST /api/worlds/[worldId]/ops`. If the server rejects a batch (for example `STALE_VERSION`), the change is rolled back and the reason is shown. The server keeps edits in memory and writes them to disk only when `STARLIGHT_WORLD_PERSIST=1`. Browser edits are always stamped `harness: human`.
- `RemoteWorldSource` is the adapter for the L2 Worker. Turn it on with `NEXT_PUBLIC_WORLD_SOURCE=remote` and `NEXT_PUBLIC_WORLD_WORKER_URL=<worker origin>`. Its wire format is provisional until L2 merges (see the comment in `remote-source.ts`).

To try the Arcanea import locally, copy `worlds/arcanea.world.json` from the private repo into `~/.starlight/agent-canvas/worlds/` (or point `STARLIGHT_WORLD_DIR` at that `worlds/` folder), run `pnpm dev`, and open `/world/arcanea`.

## Rendering

- The semantic zoom level comes from `semanticZoomLevel` in `@starlight-agent-canvas/world`. At `cluster`, only regions render, with counts by kind. At `card`, cards show the kind glyph, title and thumbnail. At `full`, they add the summary, body excerpt, tags and canon badge.
- Only tiles in the padded viewport load (LRU of 64 tiles), and only nodes in the padded viewport go to React Flow, which also culls with `onlyRenderVisibleElements`. Node components are memoized per kind, and they read the zoom level through a store selector that changes only at thresholds. Card text scales with zoom through a CSS variable, so zooming does not re-render nodes.
- At card level, long links and `references` links are hidden unless they touch the selected node.

## Keyboard

Arrow keys move to the nearest node in that direction (or the nearest region at cluster zoom). Enter edits the node (or enters a region), Escape clears the selection, `/` searches, `+` and `-` zoom, `0` fits the view. `v`, `h`, `l` and `n` pick the select, pan, link and add-node tools.

## Tools

- `pnpm world:generate -- --nodes 10000` writes a generated world to the world directory.
- `node apps/web/scripts/world-screens.mjs --set public|arcanea` renders the proof screenshots and measures frame times on the stress route. It needs a running app. Set `PW_CHROMIUM` to use a preinstalled Chromium.
