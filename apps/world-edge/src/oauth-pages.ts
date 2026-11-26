import type { ConsentDescription } from '@cloudflare/workers-oauth-provider';
import { WORLD_SCOPES, type WorldScope } from './auth.js';

/** HTML-escape. Every client-controlled string goes through this before rendering. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

const SCOPE_TEXT: Record<WorldScope, string> = {
  'world:read': 'Read worlds: records, regions and search.',
  'world:write': 'Add, edit, link, move and lay out draft nodes, and import whiteboards into empty worlds.',
  'world:propose': 'Propose nodes and edges for canon review. Never writes canon.',
};

/** Pages are never framed, never cached and run no script. */
const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'";

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:36rem;margin:3rem auto;padding:0 1rem}label{display:block;margin:.4rem 0}.warn{border-left:4px solid #b45309;padding-left:.75rem}</style>
<body>
${body}
</body>
</html>`;
}

/** Apply the page headers on top of any the provider handed us (binding cookies, no-store). */
function htmlHeaders(base?: Headers): Headers {
  const headers = new Headers(base);
  headers.delete('Location');
  headers.set('Content-Type', 'text/html; charset=utf-8');
  headers.set('Cache-Control', 'no-store');
  headers.set('Content-Security-Policy', PAGE_CSP);
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Referrer-Policy', 'no-referrer');
  return headers;
}

/**
 * Scopes the page offers: all three, ticked when the client asked for them.
 * A client that asked for none of ours gets the baseline (read and write)
 * ticked, matching the scope in the 401 challenge.
 */
export function defaultTickedScopes(requested: readonly string[]): WorldScope[] {
  const ours = WORLD_SCOPES.filter((scope) => requested.includes(scope));
  return ours.length > 0 ? ours : ['world:read', 'world:write'];
}

export function consentPage(details: ConsentDescription, handle: string, baseHeaders: Headers): Response {
  const name = escapeHtml(details.clientName);
  const publisher = details.clientDomain
    ? `<p>Published by <strong>${escapeHtml(details.clientDomain)}</strong> (verified from its client metadata document).</p>`
    : '<p>This app registered itself. Its name is <strong>not verified</strong>.</p>';
  const loopback = details.redirectIsLoopback
    ? '<p class="warn"><strong>Access will be sent to an app on your own computer.</strong> Any local program can claim this name. Continue only if you just started signing in from that app.</p>'
    : '';
  const ticked = defaultTickedScopes(details.scope);
  const scopes = WORLD_SCOPES.map(
    (scope) =>
      `<label><input type="checkbox" name="scope" value="${escapeHtml(scope)}"${ticked.includes(scope) ? ' checked' : ''}> <strong>${escapeHtml(scope)}</strong>: ${escapeHtml(SCOPE_TEXT[scope])}</label>`,
  ).join('\n');
  const body = `<h1>Allow ${name} to use World Canvas?</h1>
${publisher}
<p>Access will be sent to <strong>${escapeHtml(details.redirectHost)}</strong>.</p>
${loopback}
<form method="post" action="/authorize">
<input type="hidden" name="handle" value="${escapeHtml(handle)}">
<fieldset><legend>Permissions</legend>
${scopes}
</fieldset>
<p>You will sign in with Cloudflare Access next.</p>
<p><button type="submit" name="decision" value="approve">Allow</button> <button type="submit" name="decision" value="deny">Deny</button></p>
</form>`;
  return new Response(page(`Authorize ${details.clientName}`, body), { status: 200, headers: htmlHeaders(baseHeaders) });
}

/** A local error page. Used whenever redirecting back to the client is not safe. */
export function errorPage(message: string, status = 400, baseHeaders?: Headers): Response {
  const body = `<h1>Authorization failed</h1>
<p>${escapeHtml(message)}</p>
<p>Close this window and start the connection again from your app.</p>`;
  return new Response(page('Authorization failed', body), { status, headers: htmlHeaders(baseHeaders) });
}
