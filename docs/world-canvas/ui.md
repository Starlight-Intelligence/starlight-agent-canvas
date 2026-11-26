# World canvas UI (lane L3)

Routes in `apps/web`:

- `/world/[worldId]` opens a World Graph v1 document.
- `/world/stress` opens a generated world of 10,000 nodes. `?nodes=` changes the count, up to 100,000.

Deep-link parameters: `?node=<id>` selects a node and opens it at full zoom, `?at=x,y` centers a point, `?region=<id or title>` fits a region, `?zoom=` sets the zoom, `?view=graph|timeline|map` picks the view.

Design rules are in `docs/design/world-canvas/design-lock.md`.

## Data

The canvas reads and writes only through `WorldSource` (`apps/web/lib/world/source.ts`):

- `LocalWorldSource` holds a world in memory and serves tile queries from a spatial index. Worlds load from `GET /api/worlds/[worldId]`, which reads `<worldId>.world.json` from `STARLIGHT_WORLD_DIR`, or else from `$AGENT_CANVAS_HOME/worlds` (default `~/.starlight/agent-canvas/worlds`). World content stays out of this repo, as spec section 7 requires.
- Edits are GraphOp batches. The source applies them right away through `applyOps` with `baseVersion`, then posts them to `POST /api/worlds/[worldId]/ops` (JSON only, workspace origin only, bodies over 256 KB are refused with 413 while streaming). The shown graph is the last server-confirmed graph plus every batch still waiting for the server, replayed in order. On success the source adopts the server's copies of the changed nodes and edges, so versions match the server. On rejection (for example `STALE_VERSION`) it drops that batch, reloads the server copy, and shows the reason; it never adopts a snapshot whose `world.version` is older than a write the server already confirmed. The inspector keeps a rejected draft in the form and marks it "Not saved".
- The server reads and writes each world on one queue, so a slow first read cannot cache an older graph over a save. It keeps edits in memory and writes them to disk only when `STARLIGHT_WORLD_PERSIST=1`. When persisting, it re-reads the file if another process changed it (inode, size or mtime) before serving a read, and again under a `<world>.world.json.lock` file (created with `wx`) before each write, so a batch from this server is applied on top of the other process's edits rather than over them. Files are written to a new temp file (`wx`) and renamed into place. Browser edits are always stamped `harness: human`.
- Propose canon sets the node to `proposed` (saved like any edit). In local mode the source also keeps the proposals the server returns for this tab (`LocalWorldSource.proposals()`); the inspector shows the proposed version and says that no canon PR queue is connected, so the canon PR itself is opened through the git flow.
- `RemoteWorldSource` is the adapter for the L2 Worker. Turn it on with `NEXT_PUBLIC_WORLD_SOURCE=remote` and `NEXT_PUBLIC_WORLD_WORKER_URL=<worker origin>`. Its wire format is provisional until L2 merges (see the comment in `remote-source.ts`).

To try the Arcanea import locally, copy `worlds/arcanea.world.json` from the private repo into `~/.starlight/agent-canvas/worlds/` (or point `STARLIGHT_WORLD_DIR` at that `worlds/` folder), run `pnpm dev`, and open `/world/arcanea`.

## Rendering

- The semantic zoom level comes from `semanticZoomLevel` in `@starlight-agent-canvas/world`. At `cluster`, only regions render, with counts by kind. At `card`, cards show the kind glyph, title and thumbnail. At `full`, they add the summary, body excerpt, tags and canon badge.
- Only tiles in the padded viewport load. At most 64 tiles stay cached; when there are more, the oldest-loaded tiles outside the current view are dropped first (insertion order, not true LRU). Every change event (optimistic apply, confirmation or rollback) clears the tile cache so tiles reload with current versions.
- Only nodes in the padded viewport go to React Flow, which also culls with `onlyRenderVisibleElements`. The visible set is recomputed at most once per animation frame while panning or zooming. Node objects whose content did not change are reused, and node components are memoized per kind and read the zoom level through a store selector that changes only at thresholds, so a zoom that crosses no threshold re-renders the canvas component but not the cards. Card text scales with zoom through a CSS variable.
- At card level, long links and `references` links are hidden unless they touch the selected node.

## Keyboard

- Arrow keys move to the nearest node in that direction: regions in Map view and at cluster zoom in Graph view, timeline nodes in Timeline at any zoom. In Graph view, when no rendered node lies that way, the canvas asks the source for the nearest one further out (widening the search), pans to it and focuses it.
- Enter edits the focused node (or enters a region). `/` searches. `+` and `-` zoom, `0` fits the view.
- `v`, `h` and `l` pick the select, pan and link tools. `n` adds a note at the center of the view (Graph view only).
- Escape cancels a pending link, or clears the selection. Inside the inspector, including its fields, Escape closes it (or cancels the relation picker). Closing the inspector, by Escape or the close button, returns focus to the node it showed.
- On narrow screens the inspector is a sheet over the canvas. While it is open and focus is outside the canvas, canvas nodes leave the tab order, so Tab and Shift+Tab stay out of the covered canvas; taps on the visible canvas still work. Arrow keys pressed on the canvas still move between nodes and put focus back on the canvas.

## Tools

- `pnpm world:generate -- --nodes 10000` writes a generated world to the world directory.
- `node apps/web/scripts/world-screens.mjs --set public|arcanea` renders the proof screenshots and measures frame times on the stress route. It needs a running app. Set `PW_CHROMIUM` to use a preinstalled Chromium.
