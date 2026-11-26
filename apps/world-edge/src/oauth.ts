import { OAuthProvider, type OAuthResourceAuth } from '@cloudflare/workers-oauth-provider';
import { harnessSchema } from '@starlight-agent-canvas/world';
import { z } from 'zod';
import { unauthorized, verifyServiceToken, WORLD_SCOPES, type Principal } from './auth.js';
import type { Env } from './env.js';
import { handleMcp, MCP_ROUTE } from './mcp.js';
import { handleAuthorize, handleCallback } from './oauth-authorize.js';
import { isRedirectAllowed, parseRedirectAllowlist, type RedirectAllowEntry } from './redirect-allowlist.js';
import { notFound, routeAuthenticated } from './router.js';

/**
 * MCP OAuth 2.1 for ChatGPT and claude.ai connectors, with
 * @cloudflare/workers-oauth-provider as the combined authorization server and
 * protected resource (`/mcp`). Sign-in is Cloudflare Access for SaaS (OIDC);
 * see src/oauth-authorize.ts and src/access-oidc.ts.
 *
 * OAuth is on only when PUBLIC_ORIGIN and the OAUTH_KV binding are both
 * present. Off, every OAuth path answers 404 and /mcp takes bearer service
 * tokens exactly as before (src/router.ts). A PUBLIC_ORIGIN that is set but
 * malformed fails closed: /mcp and the OAuth paths answer 500.
 *
 * With OAuth on, /mcp accepts either an access token this provider issued for
 * `${PUBLIC_ORIGIN}/mcp`, or a static bearer service token through
 * resolveExternalToken. The provider calls resolveExternalToken only for
 * tokens not in its own issued format and not found in its KV, so a static
 * token is never taken for an OAuth token or the reverse. Access JWTs are
 * never read on this path.
 */

/** Scopes any access needs: named in the 401 challenge. */
export const REQUIRED_SCOPES = ['world:read', 'world:write'];

/** Access token lifetime: 1 hour. */
export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
/**
 * Grant (refresh token) lifetime: 7 days from sign-in, fixed, not extended by
 * refreshing. Access is consulted only at sign-in, so this bounds how long
 * someone removed from the Access policy keeps access.
 */
export const REFRESH_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;

const OAUTH_PATHS = new Set([
  '/authorize',
  '/callback',
  '/token',
  '/register',
  '/.well-known/oauth-authorization-server',
  '/.well-known/openid-configuration',
]);
const PRM_PATH = '/.well-known/oauth-protected-resource';

/** Paths that exist only when OAuth is on. */
export function isOAuthPath(pathname: string): boolean {
  return OAUTH_PATHS.has(pathname) || pathname === PRM_PATH || pathname.startsWith(`${PRM_PATH}/`);
}

function isMcpPath(pathname: string): boolean {
  return pathname === MCP_ROUTE || pathname.startsWith(`${MCP_ROUTE}/`);
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export type PublicOriginResult = { ok: true; origin: string; host: string } | { ok: false; reason: string };

/**
 * PUBLIC_ORIGIN must be exactly an origin: https (http only on a loopback
 * host), lowercase host, no default port, no path, no trailing slash, no
 * userinfo, query or fragment. Anything else is rejected, never repaired.
 */
export function parsePublicOrigin(value: string): PublicOriginResult {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, reason: 'PUBLIC_ORIGIN is not a URL.' };
  }
  const httpsOrLoopback = url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname));
  if (!httpsOrLoopback) return { ok: false, reason: 'PUBLIC_ORIGIN must be https (http only on localhost).' };
  if (url.origin !== value) return { ok: false, reason: 'PUBLIC_ORIGIN must be an origin like https://world.example.com, with no path or trailing slash.' };
  return { ok: true, origin: url.origin, host: url.hostname };
}

export type OAuthState =
  | { state: 'off' }
  | { state: 'invalid'; reason: string }
  | { state: 'on'; origin: string; provider: OAuthProvider<Env> };

let memo: { key: string; provider: OAuthProvider<Env> } | null = null;

/**
 * Decide whether OAuth is on and build the provider lazily. The public origin
 * is only known at runtime, so the provider is memoized by origin and
 * allowlist (both plain vars; they change only with a new deployment).
 */
export function resolveOAuth(env: Env): OAuthState {
  if (env.PUBLIC_ORIGIN === undefined || env.PUBLIC_ORIGIN === '' || !env.OAUTH_KV) return { state: 'off' };
  const parsed = parsePublicOrigin(env.PUBLIC_ORIGIN);
  if (!parsed.ok) return { state: 'invalid', reason: parsed.reason };
  const allowlistRaw = env.OAUTH_REDIRECT_ALLOWLIST ?? '';
  const key = `${parsed.origin}\n${allowlistRaw}`;
  if (memo?.key !== key) memo = { key, provider: buildProvider(parsed.origin, parsed.host, parseRedirectAllowlist(allowlistRaw)) };
  return { state: 'on', origin: parsed.origin, provider: memo.provider };
}

/** Test hook. */
export function resetOAuthMemo(): void {
  memo = null;
}

/** Props stored (encrypted) on an OAuth grant by completeAuthorization in src/oauth-authorize.ts. */
export const oauthGrantPropsSchema = z.object({
  kind: z.literal('oauth'),
  harness: harnessSchema,
  actor: z.string().min(1).max(200),
  sub: z.string().min(1).max(255),
  clientId: z.string().min(1),
});
export type OAuthGrantProps = z.infer<typeof oauthGrantPropsSchema>;

/** Props resolveExternalToken returns for a static bearer service token. */
const serviceTokenPropsSchema = z.object({
  kind: z.literal('service-token'),
  harness: harnessSchema,
  actor: z.string().min(1).max(200),
});

/**
 * Build the principal for /mcp only from what the provider verified.
 *
 * The provider sets ctx.auth.clientId and ctx.auth.userId from its own token
 * record for tokens it issued, and leaves both unset for tokens accepted by
 * resolveExternalToken. That, not anything in props, decides which kind of
 * principal this is. OAuth scopes come from ctx.auth.scope (the token
 * record), never from props.
 */
export function principalFromVerifiedContext(props: unknown, auth: OAuthResourceAuth | undefined): Principal | null {
  if (!auth) return null;
  if (auth.clientId === undefined && auth.userId === undefined) {
    const parsed = serviceTokenPropsSchema.safeParse(props);
    if (!parsed.success) return null;
    return { harness: parsed.data.harness, actor: parsed.data.actor, via: 'service-token' };
  }
  const parsed = oauthGrantPropsSchema.safeParse(props);
  if (!parsed.success || parsed.data.clientId !== auth.clientId) return null;
  return {
    harness: parsed.data.harness,
    actor: parsed.data.actor,
    via: 'oauth',
    scopes: WORLD_SCOPES.filter((scope) => auth.scope.includes(scope)),
  };
}

function buildProvider(origin: string, publicHost: string, allowlist: RedirectAllowEntry[]): OAuthProvider<Env> {
  const resource = `${origin}${MCP_ROUTE}`;
  return new OAuthProvider<Env>({
    apiRoute: MCP_ROUTE,
    apiHandler: {
      async fetch(request, env, ctx) {
        const auth = (ctx as ExecutionContext & { auth?: OAuthResourceAuth }).auth;
        const principal = principalFromVerifiedContext(ctx.props, auth);
        if (!principal) return unauthorized();
        return handleMcp(request, env, ctx, principal, publicHost);
      },
    },
    defaultHandler: {
      async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const { pathname } = url;
        // The provider owns /mcp; nothing here may ever serve it.
        if (isMcpPath(pathname)) return unauthorized();
        // The sign-in runs only on the public origin, like /token and /register
        // (the provider matches those by host). Elsewhere these paths do not exist.
        if ((pathname === '/authorize' || pathname === '/callback') && url.origin !== origin) return notFound();
        if (pathname === '/authorize') return handleAuthorize(request, env, { origin, allowlist });
        if (pathname === '/callback') return handleCallback(request, env, { origin, allowlist });
        // OAuth paths the provider did not answer, such as /.well-known/openid-configuration.
        if (isOAuthPath(pathname)) return notFound();
        return routeAuthenticated(request, env, ctx);
      },
    },
    // Full URLs pin the issuer to PUBLIC_ORIGIN: in the combined provider the
    // issuer is the token endpoint's origin, and a bare path would make it
    // follow whatever host a request arrived on.
    authorizeEndpoint: `${origin}/authorize`,
    tokenEndpoint: `${origin}/token`,
    clientRegistrationEndpoint: `${origin}/register`,
    clientIdMetadataDocumentEnabled: true,
    accessTokenTTL: ACCESS_TOKEN_TTL_SECONDS,
    refreshTokenTTL: REFRESH_TOKEN_TTL_SECONDS,
    scopesSupported: [...WORLD_SCOPES],
    requiredScopes: REQUIRED_SCOPES,
    resourceMetadata: {
      resource,
      authorization_servers: [origin],
      resource_name: 'World Canvas',
    },
    async resolveExternalToken({ token, env }) {
      const principal = await verifyServiceToken(token, env);
      if (!principal) return null;
      return { audience: resource, props: { kind: 'service-token', harness: principal.harness, actor: principal.actor } };
    },
    clientRegistrationCallback({ clientMetadata }) {
      const uris = clientMetadata.redirect_uris;
      if (Array.isArray(uris) && uris.length > 0 && uris.every((uri) => isRedirectAllowed(uri, allowlist))) return undefined;
      return { code: 'invalid_redirect_uri', description: 'Every redirect_uri must be on this server\'s redirect allowlist.', status: 400 };
    },
  });
}

async function withAllScopes(response: Response): Promise<Response> {
  const document = (await response.json()) as Record<string, unknown>;
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  return new Response(JSON.stringify({ ...document, scopes_supported: [...WORLD_SCOPES] }), { status: 200, headers });
}

const UNAUTHENTICATED_BODY = JSON.stringify({ error: { code: 'UNAUTHENTICATED', message: 'Authentication required.' } });

/**
 * Serve one request with OAuth on. Three adjustments to the provider's own
 * responses, all small and deliberate:
 *   1. `/.well-known/oauth-protected-resource` (no path) is answered with the
 *      provider's document for `/.well-known/oauth-protected-resource/mcp`.
 *      The provider serves only the path-specific URL; the follow-up spec (R2)
 *      also wants the root location for clients that look there.
 *   2. In that protected resource metadata, at both locations,
 *      `scopes_supported` lists all three scopes (R2). The provider fills it
 *      from requiredScopes, which must stay read and write so the 401
 *      challenge names only the baseline. Every other field is untouched.
 *   3. A 401 on /mcp keeps the provider's status and WWW-Authenticate header
 *      (resource_metadata, scope, error) but carries this Worker's JSON body,
 *      `{error: {code: "UNAUTHENTICATED", message}}`, which the world-agents
 *      client and existing tests rely on.
 */
export async function fetchWithOAuth(provider: OAuthProvider<Env>, request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  let target = request;
  if (url.pathname === PRM_PATH) {
    const alias = new URL(url);
    alias.pathname = `${PRM_PATH}${MCP_ROUTE}`;
    target = new Request(alias, request);
  }
  const response = await provider.fetch(target, env, ctx);
  const isPrm = url.pathname === PRM_PATH || url.pathname === `${PRM_PATH}${MCP_ROUTE}`;
  if (isPrm && response.status === 200 && request.method === 'GET') return withAllScopes(response);
  if (isMcpPath(url.pathname) && response.status === 401) {
    const headers = new Headers(response.headers);
    headers.set('content-type', 'application/json');
    headers.delete('content-length');
    return new Response(UNAUTHENTICATED_BODY, { status: 401, headers });
  }
  return response;
}
