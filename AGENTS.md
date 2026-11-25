# Starlight Agent Canvas Agent Instructions

This repo is an OSS-first, local-first, MCP-native research/workflow canvas.

## Product Boundary

- The first screen is the usable canvas workspace. Do not replace it with a marketing landing page.
- v0.1 is single-user and local-first. Auth, teams, billing, marketplace, and hosted sync are out of scope.
- Store runtime data outside Git by default. Use `AGENT_CANVAS_HOME`; default to the user's home `.starlight/agent-canvas`.
- Do not add social scraping, posting, outreach, payments, destructive MCP tools, or autonomous external mutations.
- Firecrawl and model provider keys are optional. The product must run without API keys.

## Engineering

- Use the existing pnpm monorepo structure: `apps/web`, `packages/core`, `packages/mcp`.
- Keep `packages/core` free of React and Next.js dependencies.
- MCP tools must be safe, explicit, and non-destructive.
- Prefer deterministic local behavior for tests. Do not require live model calls in CI.
- Before dependency installs or builds in this repo, run the root estate security intake or scan.

## Design And QA

- Apply the Starlight Premium Web OS and L99 design loop for UI work.
- Use exact design tokens from `docs/design-loop-evidence.json` and root Starlight standards.
- No decorative 3D, no heavy scroll choreography, no generic AI SaaS copy.
- The app must pass desktop, mobile, and reduced-motion visual checks before handoff.

## Health Commands

- `pnpm build`
- `pnpm typecheck`
- `pnpm test`
- `pnpm test:e2e` when Playwright browsers are available

## World Canvas Agents

A World Canvas world (for example Arcanea) is one graph of typed nodes and edges that Claude, Codex and ChatGPT edit through one remote MCP server. This is the issue #63 extension and is the one place this repo has a remote, authenticated server; its external writes are a draft canon PR (a new `canon/<slug>` branch plus one proposal file) opened by a separate git flow from a proposal the server records, for human review and merge. Before operating a world, read `.claude/skills/world-canvas/SKILL.md`. Contract: `docs/world-canvas/spec.md` and `packages/world`. Client setup: `docs/world-canvas/connect-agents.md`.

- Tools (every call takes `worldId`): `get_world`, `get_region`, `search`, `add_node`, `update_node`, `link`, `move`, `propose_canon`, `layout_region`, `import_whiteboard`. There is no delete tool.
- Op versions: writes to an existing node or edge carry `baseVersion`. On `STALE_VERSION`, re-read, merge and retry once; never overwrite blindly. The format is `starlight.worldGraph.v1`; unknown keys are rejected.
- Canon gate: agents create `draft` or `proposed` only and can never set `canon`. Use `propose_canon`, which marks targets `proposed` and records a proposal; the `canon-pr` flow then opens a draft PR adding one file under `.arcanea/lore/proposals/` in arcanea-ai-app. Never edit `CANON_LOCKED.md` or existing lore files; only the Creator approves canon.
- Regions: read by region or bounds with `get_region` and a zoom `level`, never the whole world. Place nodes inside their region's bounds.
- Attribution: the server stamps `createdBy` from the session. Do not put identity or secrets in tool arguments. Tokens come from environment variables, never literals.
- Code: `packages/world-agents` holds the typed MCP client (`src/client`) and the canon proposal to draft PR pipeline (`src/canon-pr`). Test it with `pnpm --filter @starlight-agent-canvas/world-agents test`.
