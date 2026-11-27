import { routeAgentRequest } from 'agents';
import { AuthError, authenticate, authenticateMcp, canAccessWorld, encodePrincipal, PRINCIPAL_HEADER, unauthorized, worldForbidden } from './auth.js';
import type { Env } from './env.js';
import { handleMcp, MCP_ROUTE } from './mcp.js';
import { readMedia, signUpload } from './media.js';

/**
 * Authenticated routes, as at f042d44. `request` must already have any
 * client-supplied principal header removed (src/index.ts does that first).
 *
 * /mcp here takes a bearer service token only (authenticateMcp); this path
 * serves /mcp only while OAuth is off. With OAuth on, /mcp never reaches this
 * function: the OAuth provider owns it (src/oauth.ts).
 *
 * Every other route takes a bearer service token or a browser Access identity
 * JWT (authenticate).
 */
export async function routeAuthenticated(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);

  let principal;
  try {
    principal = url.pathname === MCP_ROUTE ? await authenticateMcp(request, env) : await authenticate(request, env);
  } catch (error) {
    if (error instanceof AuthError) return Response.json({ error: { code: 'AUTH_UNAVAILABLE', message: error.message } }, { status: error.status });
    throw error;
  }
  if (!principal) return unauthorized();

  if (url.pathname === MCP_ROUTE) return handleMcp(request, env, ctx, principal);
  if (url.pathname === '/media/sign' && request.method === 'POST') return signUpload(request, env, principal);
  if (url.pathname.startsWith('/media/object/') && request.method === 'GET') return readMedia(request, env, principal);

  if (url.pathname.startsWith('/agents/')) {
    // /agents/<agent>/<worldId>[/...]: the instance name is the world id.
    const segment = url.pathname.split('/')[3] ?? '';
    let worldId: string;
    try {
      worldId = decodeURIComponent(segment);
    } catch {
      return Response.json({ error: { code: 'BAD_REQUEST', message: 'Malformed world id.' } }, { status: 400 });
    }
    if (!canAccessWorld(principal, worldId)) return worldForbidden(worldId);
    const headers = new Headers(request.headers);
    headers.set(PRINCIPAL_HEADER, encodePrincipal(principal));
    const forwarded = new Request(request, { headers });
    const response = await routeAgentRequest(forwarded, env);
    if (response) return response;
  }
  return notFound();
}

export function notFound(): Response {
  return Response.json({ error: { code: 'NOT_FOUND', message: 'Unknown route.' } }, { status: 404 });
}
