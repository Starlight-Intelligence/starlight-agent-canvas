import { applyD1Migrations } from 'cloudflare:test';
import { testEnv as env } from './helpers.js';
import { beforeAll } from 'vitest';

beforeAll(async () => {
  if (env.WORLD_INDEX) await applyD1Migrations(env.WORLD_INDEX, env.TEST_MIGRATIONS);
});
