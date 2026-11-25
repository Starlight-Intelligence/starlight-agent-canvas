#!/usr/bin/env node
// Writes a generated World Graph v1 file for stress testing.
//   pnpm world:generate -- --nodes 10000 [--out <file>] [--seed 63] [--world-id stress-10k]
// Default output: $AGENT_CANVAS_HOME/worlds (default ~/.starlight/agent-canvas/worlds), outside git.
// Uses Node type stripping (Node >= 22.18) to import the same generator the /world/stress route uses.
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateWorld } from '../lib/world/generate-world.ts';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const nodes = Number(opt('nodes', '10000'));
const worldId = opt('world-id', `stress-${nodes >= 1000 ? `${Math.round(nodes / 1000)}k` : nodes}`);
const home = process.env.AGENT_CANVAS_HOME?.trim() || path.join(os.homedir(), '.starlight', 'agent-canvas');
const out = path.resolve(opt('out', path.join(home, 'worlds', `${worldId}.world.json`)));
const graph = generateWorld({ nodes, seed: Number(opt('seed', '63')), worldId });
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(graph)}\n`);
console.log(`Wrote ${graph.nodes.length} nodes, ${graph.edges.length} edges, ${graph.world.regions.length} regions to ${out}`);
console.log(`Open /world/${worldId}${out.startsWith(path.join(home, 'worlds')) ? '' : ` with STARLIGHT_WORLD_DIR=${path.dirname(out)}`}`);
