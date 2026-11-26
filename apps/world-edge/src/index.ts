import { PRINCIPAL_HEADER } from './auth.js';
import type { Env } from './env.js';
import { MCP_ROUTE } from './mcp.js';
import { receiveUpload } from './media.js';
import { fetchWithOAuth, isOAuthPath, resolveOAuth } from './oauth.js';
import { notFound, routeAuthenticated } from './router.js';

export { WorldAgent } from './world-agent.js';

/**
 * Routes:
 *   GET  /health                      no auth
 *   POST /mcp                         MCP. OAuth on: OAuth access token or bearer service token.
 *                                     OAuth off: bearer service token only. Access JWTs never count here.
 *   *    /agents/world-agent/<world>  WorldAgent HTTP + WebSocket (Access identity or bearer)
 *   POST /media/sign                  signed R2 upload URL (auth)
 *   PUT  /media/upload?...            upload with the signed URL (signature is the credential)
 *   GET  /media/object/<key>          read media (auth)
 * With OAuth on (PUBLIC_ORIGIN and OAUTH_KV set, src/oauth.ts), also:
 *   GET  /.well-known/oauth-protected-resource[/mcp], /.well-known/oauth-authorization-server
 *   GET|POST /authorize, GET /callback   consent and Access sign-in (src/oauth-authorize.ts)
 *   POST /token, POST /register        provider-owned
 */
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // The principal header is internal. Drop any client-supplied copy before
    // anything else can read it.
    const headers = new Headers(request.headers);
    headers.delete(PRINCIPAL_HEADER);
    const clean = new Request(request, { headers });

    if (url.pathname === '/health') return Response.json({ ok: true, service: 'world-edge' });
    if (url.pathname === '/media/upload' || url.pathname === '/media/upload/') return receiveUpload(clean, env);

    const oauth = resolveOAuth(env);
    if (oauth.state === 'on') return fetchWithOAuth(oauth.provider, clean, env, ctx);

    if (oauth.state === 'invalid' && (url.pathname === MCP_ROUTE || isOAuthPath(url.pathname))) {
      console.error('world-edge: OAuth misconfigured:', oauth.reason);
      return Response.json({ error: { code: 'OAUTH_MISCONFIGURED', message: 'OAuth is misconfigured on this server.' } }, { status: 500 });
    }
    if (isOAuthPath(url.pathname)) return notFound();
    return routeAuthenticated(clean, env, ctx);
  },
} satisfies ExportedHandler<Env>;
