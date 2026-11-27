import { describe, expect, it } from 'vitest';
import { challengeWithAllScopes } from '../src/oauth-challenge.js';

describe('challengeWithAllScopes', () => {
  it('widens the scope parameter to read, write and propose and keeps the rest', () => {
    const header = 'Bearer realm="OAuth", resource_metadata="https://w.example/.well-known/oauth-protected-resource/mcp", scope="world:read world:write", error="invalid_token"';
    expect(challengeWithAllScopes(header)).toBe(
      'Bearer realm="OAuth", resource_metadata="https://w.example/.well-known/oauth-protected-resource/mcp", scope="world:read world:write world:propose", error="invalid_token"',
    );
  });
  it('leaves a challenge without a scope parameter unchanged', () => {
    expect(challengeWithAllScopes('Bearer realm="world-edge"')).toBe('Bearer realm="world-edge"');
  });
});
