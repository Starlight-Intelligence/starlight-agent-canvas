const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function normalizeOrigin(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** Extra origins from WORLD_ALLOWED_ORIGINS (comma-separated), normalised. */
export function allowedExtraOrigins(env: Record<string, string | undefined> = process.env): string[] {
  return (env.WORLD_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map(normalizeOrigin)
    .filter((origin): origin is string => origin !== null);
}

/**
 * True when `origin` may write to the local workspace: localhost, 127.0.0.1 or
 * [::1] on any port (http or https), or an origin listed in
 * WORLD_ALLOWED_ORIGINS. The request Host header is never consulted, so a
 * DNS-rebinding page (attacker.example resolving to 127.0.0.1) is refused.
 */
export function isAllowedOrigin(origin: string, env: Record<string, string | undefined> = process.env): boolean {
  const normalized = normalizeOrigin(origin);
  if (!normalized) return false;
  const url = new URL(normalized);
  if (LOOPBACK_HOSTS.has(url.hostname)) return true;
  return allowedExtraOrigins(env).includes(normalized);
}

/**
 * True when a state-changing request must be refused: an Origin header that is
 * not allowed, or a browser-signalled fetch that is not same-origin.
 * A request with neither Origin nor Sec-Fetch-Site (curl, MCP clients) is a
 * non-browser local client and passes. Browsers always send Sec-Fetch-Site, so
 * when it is present it must be `same-origin` (or `none`, a user-initiated
 * navigation); `same-site`, `cross-site` and unknown values are refused.
 */
export function originDenied(request: Request, env: Record<string, string | undefined> = process.env): boolean {
  const site = request.headers.get('sec-fetch-site');
  if (site !== null && site !== 'same-origin' && site !== 'none') return true;
  const origin = request.headers.get('origin');
  return origin !== null && origin !== '' && !isAllowedOrigin(origin, env);
}
