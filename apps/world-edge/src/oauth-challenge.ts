import { WORLD_SCOPES } from './auth.js';

/**
 * Rewrite the `scope` parameter of a Bearer challenge to name every scope this
 * Worker grants. The provider builds the challenge from requiredScopes
 * (read and write: the baseline a token must hold). An MCP client that
 * follows only the challenge would then never ask for world:propose, so the
 * challenge advertises all three while requiredScopes stays at the baseline.
 * A header without a scope parameter is returned unchanged.
 */
export function challengeWithAllScopes(header: string): string {
  return header.replace(/scope="[^"]*"/, `scope="${WORLD_SCOPES.join(' ')}"`);
}
