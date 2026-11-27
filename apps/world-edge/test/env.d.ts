/// <reference types="@cloudflare/vitest-plugin/types" />

/** Vite raw imports (test/oauth-units.test.ts reads the config files as text). */
declare module '*?raw' {
  const content: string;
  export default content;
}
