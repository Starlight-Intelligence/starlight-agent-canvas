/**
 * OAuth redirect URI allowlist (OAUTH_REDIRECT_ALLOWLIST).
 *
 * The provider already requires a request's redirect URI to be one the client
 * registered (DCR) or listed in its metadata document (CIMD). This list is a
 * second, operator-owned gate: only redirect URIs on it can ever receive an
 * authorization code from this Worker.
 *
 * Entries are separated by whitespace or commas. Each entry is one of:
 *   - an exact https URI, compared as an exact string
 *     (https://claude.ai/api/mcp/auth_callback);
 *   - an https prefix ending in "/*", which matches only deeper path segments
 *     under that path on exactly that host, with no port, query, fragment or
 *     userinfo (https://chatgpt.com/connector/oauth/* matches
 *     https://chatgpt.com/connector/oauth/abc123, not .../oauth or .../oauthx);
 *   - the literal token "loopback", which allows
 *     http://localhost[:port]/callback and http://127.0.0.1[:port]/callback,
 *     optionally with one more /<callback_id> segment.
 *
 * An entry that is none of these is ignored (it can never match) and logged.
 * An unset or empty list allows nothing.
 */

export type RedirectAllowEntry =
  | { kind: 'exact'; uri: string }
  | { kind: 'prefix'; origin: string; path: string }
  | { kind: 'loopback' };

/** One path segment of unreserved characters: no percent escapes, no dots-only tricks beyond what URL parsing removed. */
const SEGMENT = /^[A-Za-z0-9._~-]+$/;

/**
 * Parse a candidate URI and require it to already be in canonical form, so
 * nothing the URL parser would rewrite (case, dot segments, default ports,
 * percent-encoded dots) can make two spellings compare differently.
 */
function canonicalUrl(value: string): URL | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.href !== value) return null;
  if (url.username || url.password || url.hash) return null;
  return url;
}

function parseEntry(raw: string): RedirectAllowEntry | null {
  if (raw === 'loopback') return { kind: 'loopback' };
  if (raw.endsWith('/*')) {
    const base = canonicalUrl(raw.slice(0, -2));
    if (!base || base.protocol !== 'https:' || base.port || base.search || base.pathname === '/') return null;
    if (base.pathname.endsWith('/')) return null;
    return { kind: 'prefix', origin: base.origin, path: base.pathname };
  }
  const url = canonicalUrl(raw);
  if (!url || url.protocol !== 'https:' || url.port || url.search) return null;
  return { kind: 'exact', uri: raw };
}

export function parseRedirectAllowlist(value: string | undefined): RedirectAllowEntry[] {
  const entries: RedirectAllowEntry[] = [];
  for (const raw of (value ?? '').split(/[\s,]+/).filter(Boolean)) {
    const entry = parseEntry(raw);
    if (entry) entries.push(entry);
    else console.warn('world-edge: ignoring invalid OAUTH_REDIRECT_ALLOWLIST entry', JSON.stringify(raw.slice(0, 200)));
  }
  return entries;
}

function matchesEntry(entry: RedirectAllowEntry, uri: string, url: URL): boolean {
  switch (entry.kind) {
    case 'exact':
      return uri === entry.uri;
    case 'prefix': {
      if (url.protocol !== 'https:' || url.origin !== entry.origin || url.port || url.search) return false;
      if (!url.pathname.startsWith(`${entry.path}/`)) return false;
      const rest = url.pathname.slice(entry.path.length + 1).split('/');
      return rest.every((segment) => SEGMENT.test(segment));
    }
    case 'loopback': {
      if (url.protocol !== 'http:' || (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') || url.search) return false;
      if (url.pathname === '/callback') return true;
      const match = /^\/callback\/([^/]+)$/.exec(url.pathname);
      return match !== null && SEGMENT.test(match[1]!);
    }
  }
}

/** True only when `uri` is canonical and matches at least one entry. */
export function isRedirectAllowed(uri: unknown, entries: readonly RedirectAllowEntry[]): boolean {
  if (typeof uri !== 'string' || entries.length === 0) return false;
  const url = canonicalUrl(uri);
  if (!url) return false;
  return entries.some((entry) => matchesEntry(entry, uri, url));
}
