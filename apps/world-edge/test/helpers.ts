import { getAgentByName } from 'agents';
import { env } from 'cloudflare:test';
import type { D1Migration } from 'cloudflare:test';
import type { Principal } from '../src/auth.js';

/** Test-only bindings added in vitest.config.ts. */
export const testEnv = env as typeof env & { TEST_MIGRATIONS: D1Migration[]; TEST_TOKENS: { claude: string; codex: string } };

export const claude: Principal = { harness: 'claude', actor: 'claude-test', via: 'service-token' };
export const codex: Principal = { harness: 'codex', actor: 'codex-test', via: 'service-token' };
export const human: Principal = { harness: 'human', actor: 'frank@example.com', via: 'access' };

let counter = 0;
/** A fresh world per test; Durable Object storage is isolated per name. */
export function worldName(prefix = 'w'): string {
  counter += 1;
  return `${prefix}-${counter}-${crypto.randomUUID().slice(0, 8)}`;
}

export function agentFor(name: string) {
  return getAgentByName(env.WorldAgent, name);
}

export function nodeOp(id: string, x = 0, y = 0, extra: Record<string, unknown> = {}) {
  return { op: 'addNode', node: { id, kind: 'character', title: `Title ${id}`, position: { x, y }, ...extra } };
}

export function bearer(token: string): HeadersInit {
  return { authorization: `Bearer ${token}` };
}
