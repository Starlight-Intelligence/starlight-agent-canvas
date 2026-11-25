import { routeAgentRequest } from 'agents';
import { AuthError, authenticate, encodePrincipal, PRINCIPAL_HEADER, unauthorized } from './auth.js';
import type { Env } from './env.js';
import { handleMcp, MCP_ROUTE } from './mcp.js';
import { readMedia, receiveUpload, signUpload } from './media.js';

export { WorldAgent } from './world-agent.js';

/**
 * Routes:
 *   GET  /health                      no auth
 *   POST /mcp                         MCP (bearer service token or Access)
 *   *    /agents/world-agent/<world>  WorldAgent HTTP + WebSocket (Access or bearer)
 *   POST /media/sign                  signed R2 upload URL (auth)
 *   PUT  /media/upload?...            upload with the signed URL (signature is the credential)
 *   GET  /media/object/<key>          read media (auth)
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
    if (url.pathname === '/media/upload') return receiveUpload(clean, env);

    let principal;
    try {
      principal = await authenticate(clean, env);
    } catch (error) {
      if (error instanceof AuthError) return Response.json({ error: { code: 'AUTH_UNAVAILABLE', message: error.message } }, { status: error.status });
      throw error;
    }
    if (!principal) return unauthorized();

    if (url.pathname === MCP_ROUTE) return handleMcp(clean, env, ctx, principal);
    if (url.pathname === '/media/sign' && request.method === 'POST') return signUpload(clean, env, principal);
    if (url.pathname.startsWith('/media/object/') && request.method === 'GET') return readMedia(clean, env);

    if (url.pathname.startsWith('/agents/')) {
      headers.set(PRINCIPAL_HEADER, encodePrincipal(principal));
      const forwarded = new Request(clean, { headers });
      const response = await routeAgentRequest(forwarded, env);
      if (response) return response;
    }
    return Response.json({ error: { code: 'NOT_FOUND', message: 'Unknown route.' } }, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
