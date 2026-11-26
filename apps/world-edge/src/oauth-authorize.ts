import { AuthorizationError, authorizationErrorRedirect, CimdFetchError, type AuthRequest, type OAuthHelpers } from '@cloudflare/workers-oauth-provider';
import { accessAuthorizeUrl, exchangeAccessCode, randomToken, readAccessOidcConfig, s256, UpstreamError, verifyAccessIdToken } from './access-oidc.js';
import { AuthError, isWorldScope, type WorldScope } from './auth.js';
import type { Env } from './env.js';
import { harnessForClient } from './harness.js';
import type { OAuthGrantProps } from './oauth.js';
import { consentPage, errorPage } from './oauth-pages.js';
import { isRedirectAllowed, type RedirectAllowEntry } from './redirect-allowlist.js';

/**
 * The application half of the OAuth flow: /authorize (consent) and /callback
 * (return from Cloudflare Access). The provider validates the client and its
 * registered redirect URI; this file adds the operator's redirect allowlist,
 * the consent page, the Access sign-in, and the harness label.
 *
 *   GET  /authorize  parseAuthRequest -> allowlist -> describeConsent + beginConsent -> consent page
 *   POST /authorize  deny:    denyConsent -> 302 to client with error=access_denied, state, iss
 *                    approve: approveConsent -> beginUpstream (PKCE verifier, nonce) -> 302 to Access
 *   GET  /callback   finishUpstream -> allowlist -> Access token exchange -> id_token checks
 *                    -> completeAuthorization -> 302 to client with code, state, iss
 *
 * Redirects back to the client happen only to a redirect URI the provider
 * validated and the allowlist accepts. Every other failure is a local page.
 */

export interface AuthorizeContext {
  /** PUBLIC_ORIGIN. */
  origin: string;
  allowlist: readonly RedirectAllowEntry[];
}

/** Data kept server-side (encrypted by the provider) between the Access redirect and /callback. */
interface UpstreamData {
  verifier: string;
  nonce: string;
}

function isUpstreamData(value: unknown): value is UpstreamData {
  const v = value as Partial<UpstreamData> | null;
  return typeof v?.verifier === 'string' && v.verifier.length >= 43 && typeof v.nonce === 'string' && v.nonce.length >= 32;
}

const NOT_ALLOWED = 'This app\'s redirect address is not on this server\'s allowlist, so it cannot be authorized here.';

/** Expected helper failures become a local page; anything else is a bug or an outage and surfaces as a 500. */
function helperErrorPage(error: unknown, headers?: Headers): Response {
  if (error instanceof AuthorizationError) return errorPage(error.description, 400, headers);
  if (error instanceof CimdFetchError) return errorPage('This app could not be verified: its client metadata document could not be loaded.', 400, headers);
  throw error;
}

function redirect(location: string, headers = new Headers()): Response {
  headers.set('Location', location);
  headers.set('Cache-Control', 'no-store');
  return new Response(null, { status: 302, headers });
}

function helpers(env: Env): OAuthHelpers | null {
  return env.OAUTH_PROVIDER ?? null;
}

export async function handleAuthorize(request: Request, env: Env, c: AuthorizeContext): Promise<Response> {
  const oauth = helpers(env);
  if (!oauth) return errorPage('OAuth is not available on this server.', 500);
  const access = readAccessOidcConfig(env);
  if (!access.ok) {
    console.error('world-edge: OAuth sign-in is not configured:', access.reason);
    return errorPage('Sign-in is not configured on this server.', 503);
  }
  if (request.method === 'GET') return authorizeGet(request, oauth, c);
  if (request.method === 'POST') return authorizePost(request, oauth, c, access.config);
  return new Response(null, { status: 405, headers: { Allow: 'GET, POST' } });
}

async function authorizeGet(request: Request, oauth: OAuthHelpers, c: AuthorizeContext): Promise<Response> {
  let authRequest: AuthRequest;
  try {
    authRequest = await oauth.parseAuthRequest(request);
  } catch (error) {
    // The library sets redirectTo only after it validated the client and its
    // exact registered redirect URI; the allowlist must accept it too.
    if (error instanceof AuthorizationError && error.redirectTo && isRedirectAllowed(error.redirectUri, c.allowlist)) {
      return redirect(error.redirectTo);
    }
    return helperErrorPage(error);
  }
  if (!isRedirectAllowed(authRequest.redirectUri, c.allowlist)) return errorPage(NOT_ALLOWED);

  // PKCE with S256 for every client. The library already demands it from
  // public clients and refuses "plain"; this extends it to confidential DCR
  // clients (OAuth 2.1). authRequest was validated by the library and its
  // redirect URI passed the allowlist, so the error may go back to the client.
  if (!authRequest.codeChallenge || authRequest.codeChallengeMethod !== 'S256') {
    return redirect(authorizationErrorRedirect(authRequest, 'invalid_request', 'PKCE with code_challenge_method=S256 is required.'));
  }

  try {
    // describeConsent first: a failed client lookup leaves nothing in KV.
    const details = await oauth.describeConsent(authRequest);
    const consent = await oauth.beginConsent(authRequest);
    return consentPage(details, consent.handle, consent.headers);
  } catch (error) {
    return helperErrorPage(error);
  }
}

async function authorizePost(
  request: Request,
  oauth: OAuthHelpers,
  c: AuthorizeContext,
  access: Extract<ReturnType<typeof readAccessOidcConfig>, { ok: true }>['config'],
): Promise<Response> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return errorPage('The consent form could not be read.');
  }
  const handle = form.get('handle');
  if (typeof handle !== 'string' || handle.length === 0) return errorPage('The consent form is incomplete; start again.');
  const decision = form.get('decision');

  if (decision === 'deny') {
    let denied;
    try {
      denied = await oauth.denyConsent(request, handle);
    } catch (error) {
      return helperErrorPage(error);
    }
    if (!isRedirectAllowed(denied.request.redirectUri, c.allowlist)) return errorPage(NOT_ALLOWED, 400, denied.headers);
    // denied.headers carries Location: the client's redirect URI with error=access_denied, state and iss.
    return new Response(null, { status: 302, headers: denied.headers });
  }
  if (decision !== 'approve') return errorPage('Choose Allow or Deny.');

  const ticked = form.getAll('scope');
  if (!ticked.every(isWorldScope)) return errorPage('The consent form named an unknown permission; start again.');
  const scope = [...new Set(ticked as WorldScope[])];
  // Checked before approveConsent so the handle is not used up: the user can go back and tick one.
  if (scope.length === 0) return errorPage('Choose at least one permission, or Deny.');

  let approved;
  try {
    approved = await oauth.approveConsent(request, handle, { scope });
  } catch (error) {
    return helperErrorPage(error);
  }
  if (!isRedirectAllowed(approved.request.redirectUri, c.allowlist)) return errorPage(NOT_ALLOWED, 400, approved.headers);

  const data: UpstreamData = { verifier: randomToken(), nonce: randomToken() };
  const { state, headers } = await oauth.beginUpstream(approved.request, { data, headers: approved.headers });
  const location = accessAuthorizeUrl(access, {
    redirectUri: `${c.origin}/callback`,
    state,
    nonce: data.nonce,
    codeChallenge: await s256(data.verifier),
  });
  return redirect(location, headers);
}

export async function handleCallback(request: Request, env: Env, c: AuthorizeContext): Promise<Response> {
  const oauth = helpers(env);
  if (!oauth) return errorPage('OAuth is not available on this server.', 500);
  if (request.method !== 'GET') return new Response(null, { status: 405, headers: { Allow: 'GET' } });

  let resumed;
  try {
    resumed = await oauth.finishUpstream<unknown>(request);
  } catch (error) {
    return helperErrorPage(error);
  }
  const { request: original, data, headers } = resumed;
  if (!isRedirectAllowed(original.redirectUri, c.allowlist)) return errorPage(NOT_ALLOWED, 400, headers);

  const refuse = (reason: string): Response => {
    console.warn('world-edge: OAuth sign-in refused:', reason);
    return redirect(authorizationErrorRedirect(original, 'access_denied', 'Sign-in was declined or could not be verified.'), headers);
  };

  const params = new URL(request.url).searchParams;
  if (params.has('error')) return refuse('Access returned an error.');
  const code = params.get('code');
  if (!code) return refuse('Access returned no code.');
  if (!isUpstreamData(data)) return refuse('Stored sign-in data is missing.');

  const access = readAccessOidcConfig(env);
  if (!access.ok) {
    console.error('world-edge: OAuth sign-in is not configured:', access.reason);
    return errorPage('Sign-in is not configured on this server.', 503, headers);
  }

  let identity;
  try {
    const idToken = await exchangeAccessCode(access.config, { code, redirectUri: `${c.origin}/callback`, codeVerifier: data.verifier });
    identity = await verifyAccessIdToken(idToken, access.config, { nonce: data.nonce });
  } catch (error) {
    if (error instanceof UpstreamError || error instanceof AuthError) return refuse(error.message);
    throw error;
  }

  // The approved scopes (approveConsent only accepts scopes in scopesSupported).
  const scope = original.scope.filter(isWorldScope);
  if (scope.length === 0) return refuse('No scope was approved.');

  // Computed here, server-side, from the validated client_id and redirect URI.
  const harness = harnessForClient({ clientId: original.clientId, redirectUri: original.redirectUri });
  const props: OAuthGrantProps = { kind: 'oauth', harness, actor: identity.email, sub: identity.sub, clientId: original.clientId };

  let redirectTo: string;
  try {
    ({ redirectTo } = await oauth.completeAuthorization({
      request: original,
      // userId must not contain ":"; encoding is a no-op for Access's UUID subjects.
      userId: encodeURIComponent(identity.sub),
      scope,
      metadata: { harness },
      props,
    }));
  } catch (error) {
    // completeAuthorization looks the client up again and re-validates the
    // redirect URI, so it can fail if the client was deleted or its metadata
    // document changed since consent. Any failure here ends on a local page
    // that still clears the sign-in cookie; nothing is issued.
    if (error instanceof AuthorizationError || error instanceof CimdFetchError) return helperErrorPage(error, headers);
    console.error('world-edge: completeAuthorization failed:', error instanceof Error ? error.message : String(error));
    return errorPage('This authorization can no longer be completed. Start again from your app.', 400, headers);
  }
  return redirect(redirectTo, headers);
}
