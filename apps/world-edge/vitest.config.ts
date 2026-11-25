import { createHash } from 'node:crypto';
import path from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import agents from 'agents/vite';
import { defineConfig } from 'vitest/config';

const root = import.meta.dirname;

/** Test-only service tokens. Not secrets: they exist only inside the local test runtime. */
export const TEST_TOKENS = {
  claude: 'test-token-claude-0123456789abcdef',
  codex: 'test-token-codex-0123456789abcdef',
} as const;

const sha = (value: string) => createHash('sha256').update(value).digest('hex');

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(root, 'migrations'));
  return {
    plugins: [
      agents(),
      cloudflareTest({
        // No AI or Vectorize locally; keep everything in-process.
        remoteBindings: false,
        wrangler: { configPath: path.join(root, 'test/wrangler.test.jsonc') },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            TEST_TOKENS,
            MCP_SERVICE_TOKENS: JSON.stringify([
              { name: 'claude-test', harness: 'claude', sha256: sha(TEST_TOKENS.claude) },
              { name: 'codex-test', harness: 'codex', sha256: sha(TEST_TOKENS.codex) },
            ]),
            MEDIA_SIGNING_KEY: 'test-only-media-signing-key',
          },
        },
      }),
    ],
    test: {
      include: [path.join(root, 'test/**/*.test.ts')],
      setupFiles: [path.join(root, 'test/setup.ts')],
      testTimeout: 20_000,
      teardownTimeout: 60_000,
    },
  };
});
