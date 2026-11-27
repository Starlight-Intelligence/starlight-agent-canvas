import { OAuthProvider, getOAuthApi, type OAuthProviderOptions } from '@cloudflare/workers-oauth-provider';
import { createExecutionContext, SELF, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetJwksCache } from '../src/auth.js';
import type { Env } from '../src/env.js';
import worker from '../src/index.js';
import { agentFor, testEnv, worldName } from './helpers.js';
import {
  ACCESS_AUTHORIZATION_URL,
  ACCESS_CLIENT_ID,
  accessClaims,
  approveToAccess,
  authorizeUrl,
  callback,
  CHATGPT_CIMD,
  CHATGPT_REDIRECT,
  chatgptCimdDocument,
  CLAUDE_AI_CALLBACK,
  CookieJar,
  mcp,
  mockUpstream,
  openConsent,
  ORIGIN,
  postConsent,
  randomString,
  registerClient,
  RESOURCE,
  s256,
  signingKey,
  tokenRequest,
  type FlowStart,
  type SigningKey,
} from './oauth-helpers.js';

beforeEach(() => resetJwksCache());
afterEach(() => vi.restoreAllMocks());

const PRM_URL = `${ORIGIN}/.well-known/oauth-protected-resource/mcp`;

/** OAuthHelpers on the test KV, for setting up state the public endpoints would refuse. */
function kvHelpers() {
  return getOAuthApi({
    apiRoute: '/mcp', apiHandler: { fetch: async () => new Response() }, defaultHandler: { fetch: async () => new Response() },
    authorizeEndpoint: `${ORIGIN}/authorize`, tokenEndpoint: `${ORIGIN}/token`, resourceMetadata: { resource: RESOURCE, authorization_servers: [ORIGIN] },
  }, { ...testEnv, OAUTH_PROVIDER: undefined } as unknown as Env);
}

/**
 * Call the Worker's own fetch with a modified env (same KV and Durable
 * Objects). A changed OAUTH_REDIRECT_ALLOWLIST rebuilds the memoized provider.
 */
async function fetchWithEnv(env: Partial<Env>, url: string, init: RequestInit, jar?: CookieJar): Promise<Response> {
  const ctx = createExecutionContext();
  const headers = new Headers(init.headers);
  for (const [k, v] of Object.entries(jar?.header() ?? {})) headers.set(k, v);
  const response = await worker.fetch(new Request(url, { ...init, headers, redirect: 'manual' }), { ...testEnv, OAUTH_PROVIDER: undefined, ...env } as unknown as Env, ctx);
  await waitOnExecutionContext(ctx);
  jar?.absorb(response);
  return response;
}

const ONLY_CHATGPT = { OAUTH_REDIRECT_ALLOWLIST: 'https://chatgpt.com/connector_platform_oauth_redirect' };

async function registerClaudeAi(): Promise<string> {
  const response = await registerClient({ client_name: 'Claude', redirect_uris: [CLAUDE_AI_CALLBACK] });
  expect(response.status).toBe(201);
  return ((await response.json()) as { client_id: string }).client_id;
}

/**
 * Run the whole code flow: consent, Access sign-in (mocked), callback, token.
 * `claims` shapes the id_token Access returns.
 */
async function codeFlow(params: {
  clientId: string;
  redirectUri: string;
  approve?: string[];
  key?: SigningKey;
  cimd?: Record<string, unknown>;
  claims?: (nonce: string) => Record<string, unknown>;
}) {
  const key = params.key ?? (await signingKey());
  let nonce = '';
  const upstream = mockUpstream({
    key,
    cimd: params.cimd,
    idToken: async () => key.sign(params.claims ? params.claims(nonce) : accessClaims(nonce)),
  });
  const { start, accessRedirect, consentHtml } = await approveToAccess({ clientId: params.clientId, redirectUri: params.redirectUri, approve: params.approve });
  nonce = accessRedirect.searchParams.get('nonce')!;
  const cb = await callback(start, { code: 'access-code-1', state: accessRedirect.searchParams.get('state')! });
  return { start, accessRedirect, consentHtml, callbackResponse: cb, upstream };
}

async function exchange(start: FlowStart, location: string) {
  const code = new URL(location).searchParams.get('code')!;
  return tokenRequest({
    grant_type: 'authorization_code',
    code,
    redirect_uri: start.redirectUri,
    code_verifier: start.verifier,
    client_id: start.clientId,
    resource: RESOURCE,
  });
}

/** Full flow to an access token. */
async function accessToken(params: Parameters<typeof codeFlow>[0]) {
  const flow = await codeFlow(params);
  expect(flow.callbackResponse.status).toBe(302);
  const location = flow.callbackResponse.headers.get('location')!;
  const token = await exchange(flow.start, location);
  expect(token.status).toBe(200);
  return { ...flow, location, token: token.body.access_token as string, tokenBody: token.body };
}

function addNode(worldId: string, extra: Record<string, unknown> = {}) {
  return { name: 'add_node', arguments: { worldId, node: { kind: 'place', title: 'OAuth Gate', position: { x: 0, y: 0 }, ...extra } } };
}

// ---------------------------------------------------------------------------
// Acceptance tests 1 and 2 (R1.2, R2, R3)
// ---------------------------------------------------------------------------

describe('OAuth discovery', () => {
  it('401 on POST /mcp with no token or a garbage token, with the R1.2 challenge', async () => {
    for (const token of [null, 'garbage-token-garbage-token', 'user:grant:secret', `${'a'.repeat(20)}`]) {
      const result = await mcp(token, 'tools/list');
      expect(result.status).toBe(401);
      const challenge = result.headers.get('www-authenticate') ?? '';
      expect(challenge.startsWith(`Bearer realm="OAuth", resource_metadata="${PRM_URL}"`)).toBe(true);
      expect(challenge).toContain(`resource_metadata="${PRM_URL}"`);
      // A client that follows only the challenge must be able to ask for propose too.
      expect(challenge).toContain('scope="world:read world:write world:propose"');
      expect(JSON.parse(result.text)).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
    }
  });

  it('serves protected resource metadata at the path-specific and root locations, with all three scopes', async () => {
    const specific = await SELF.fetch(PRM_URL);
    expect(specific.status).toBe(200);
    expect(specific.headers.get('content-type')).toContain('application/json');
    const doc = (await specific.json()) as Record<string, unknown>;
    expect(doc).toEqual({
      resource: RESOURCE,
      authorization_servers: [ORIGIN],
      scopes_supported: ['world:read', 'world:write', 'world:propose'],
      bearer_methods_supported: ['header'],
      resource_name: 'World Canvas',
    });
    const root = await SELF.fetch(`${ORIGIN}/.well-known/oauth-protected-resource`);
    expect(root.status).toBe(200);
    expect(await root.json()).toEqual(doc);
  });

  it('serves RFC 8414 metadata whose issuer equals the authorization_servers entry', async () => {
    const prm = (await (await SELF.fetch(PRM_URL)).json()) as { authorization_servers: string[] };
    const response = await SELF.fetch(`${ORIGIN}/.well-known/oauth-authorization-server`);
    expect(response.status).toBe(200);
    const as = (await response.json()) as Record<string, unknown>;
    expect(as.issuer).toBe(ORIGIN);
    expect(as.issuer).toBe(prm.authorization_servers[0]);
    expect(as).toMatchObject({
      authorization_endpoint: `${ORIGIN}/authorize`,
      token_endpoint: `${ORIGIN}/token`,
      registration_endpoint: `${ORIGIN}/register`,
      authorization_response_iss_parameter_supported: true,
      client_id_metadata_document_supported: true,
      response_types_supported: ['code'],
      scopes_supported: ['world:read', 'world:write', 'world:propose'],
    });
    expect(as.code_challenge_methods_supported).toEqual(['S256']);
    expect(as.token_endpoint_auth_methods_supported).toEqual(expect.arrayContaining(['none', 'private_key_jwt']));
    expect(as.grant_types_supported).toEqual(expect.arrayContaining(['authorization_code', 'refresh_token']));
  });

  it('does not serve /.well-known/openid-configuration (the provider serves RFC 8414 only)', async () => {
    expect((await SELF.fetch(`${ORIGIN}/.well-known/openid-configuration`)).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Acceptance tests 3 and 5 (R1.4, R4): full code flow with PKCE
// ---------------------------------------------------------------------------

describe('OAuth code flow through Cloudflare Access', () => {
  it('DCR client with the claude.ai callback: consent, Access, code with iss, token for /mcp, add_node as claude-ai', async () => {
    const clientId = await registerClaudeAi();
    const flow = await accessToken({ clientId, redirectUri: CLAUDE_AI_CALLBACK });

    // Consent page: client name, unverified (DCR), redirect host, scopes as checkboxes.
    expect(flow.consentHtml).toContain('Allow Claude to use World Canvas?');
    expect(flow.consentHtml).toContain('not verified');
    expect(flow.consentHtml).toContain('<strong>claude.ai</strong>');
    expect(flow.consentHtml).toMatch(/type="checkbox" name="scope" value="world:read" checked/);
    expect(flow.consentHtml).toMatch(/type="checkbox" name="scope" value="world:propose">/);

    // Access redirect: OIDC code flow with S256 PKCE and a nonce.
    const access = flow.accessRedirect;
    expect(`${access.origin}${access.pathname}`).toBe(ACCESS_AUTHORIZATION_URL);
    expect(Object.fromEntries(access.searchParams)).toMatchObject({
      client_id: ACCESS_CLIENT_ID,
      redirect_uri: `${ORIGIN}/callback`,
      response_type: 'code',
      scope: 'openid email profile',
      code_challenge_method: 'S256',
    });
    expect(access.searchParams.get('nonce')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(access.searchParams.get('state')).toBeTruthy();

    // Token request to Access: client_secret_post with the PKCE verifier for that challenge.
    const sent = flow.upstream.tokenRequests[0]!.form;
    expect(Object.fromEntries(sent)).toMatchObject({
      grant_type: 'authorization_code',
      code: 'access-code-1',
      redirect_uri: `${ORIGIN}/callback`,
      client_id: ACCESS_CLIENT_ID,
      client_secret: 'test-only-access-client-secret',
    });
    expect(await s256(sent.get('code_verifier')!)).toBe(access.searchParams.get('code_challenge'));

    // Back to the client: code, state and iss (RFC 9207).
    const back = new URL(flow.location);
    expect(`${back.origin}${back.pathname}`).toBe(CLAUDE_AI_CALLBACK);
    expect(back.searchParams.get('code')).toBeTruthy();
    expect(back.searchParams.get('state')).toBe(flow.start.clientState);
    expect(back.searchParams.get('iss')).toBe(ORIGIN);

    // Token bound to the resource.
    expect(flow.tokenBody).toMatchObject({ token_type: 'bearer', resource: RESOURCE, scope: 'world:read world:write' });
    // A refresh token comes back although the client never asked for offline_access.
    expect(flow.tokenBody.refresh_token).toBeTruthy();

    const worldId = worldName('oauth-claude');
    const added = await mcp(flow.token, 'tools/call', addNode(worldId));
    expect(added.status).toBe(200);
    expect(added.tool).toMatchObject({ ok: true, nodes: [{ createdBy: { harness: 'claude-ai', actor: 'writer@example.com' } }] });
    const log = await (await agentFor(worldId)).listOps(0, 10);
    expect(log.map((e) => ({ harness: e.harness, actor: e.actor }))).toEqual([{ harness: 'claude-ai', actor: 'writer@example.com' }]);
  });

  it('ChatGPT CIMD client: document fetched, consent shows chatgpt.com, add_node as chatgpt', async () => {
    const cimd = { [CHATGPT_CIMD]: chatgptCimdDocument() };
    const flow = await accessToken({ clientId: CHATGPT_CIMD, redirectUri: CHATGPT_REDIRECT, cimd });
    expect(flow.upstream.cimdFetches).toContain(CHATGPT_CIMD);
    expect(flow.consentHtml).toContain('Allow ChatGPT to use World Canvas?');
    expect(flow.consentHtml).toContain('Published by <strong>chatgpt.com</strong>');

    const back = new URL(flow.location);
    expect(`${back.origin}${back.pathname}`).toBe(CHATGPT_REDIRECT);
    expect(back.searchParams.get('iss')).toBe(ORIGIN);
    expect(back.searchParams.get('state')).toBe(flow.start.clientState);
    expect(flow.tokenBody.resource).toBe(RESOURCE);

    const worldId = worldName('oauth-chatgpt');
    const read = await mcp(flow.token, 'tools/call', { name: 'get_world', arguments: { worldId } });
    expect(read.status).toBe(200);
    const added = await mcp(flow.token, 'tools/call', addNode(worldId));
    expect(added.tool).toMatchObject({ ok: true, nodes: [{ createdBy: { harness: 'chatgpt', actor: 'writer@example.com' } }] });
  });

  it("claude.ai with Claude's published identity (CIMD): consent shows claude.ai, add_node as claude-ai", async () => {
    const clientId = 'https://claude.ai/oauth/mcp-oauth-client-metadata';
    const cimd = {
      [clientId]: {
        client_id: clientId,
        client_name: 'Claude',
        redirect_uris: [CLAUDE_AI_CALLBACK],
        grant_types: ['authorization_code', 'refresh_token', 'urn:ietf:params:oauth:grant-type:jwt-bearer'],
        token_endpoint_auth_method: 'none',
      },
    };
    const flow = await accessToken({ clientId, redirectUri: CLAUDE_AI_CALLBACK, cimd });
    expect(flow.upstream.cimdFetches).toContain(clientId);
    expect(flow.consentHtml).toContain('Published by <strong>claude.ai</strong>');
    expect(new URL(flow.location).searchParams.get('iss')).toBe(ORIGIN);
    expect(flow.tokenBody.resource).toBe(RESOURCE);
    const added = await mcp(flow.token, 'tools/call', addNode(worldName('oauth-claude-cimd')));
    expect(added.tool).toMatchObject({ ok: true, nodes: [{ createdBy: { harness: 'claude-ai', actor: 'writer@example.com' } }] });
  });

  it('ChatGPT through dynamic registration with its stable redirect: add_node as chatgpt', async () => {
    const response = await registerClient({ client_name: 'ChatGPT', redirect_uris: [CHATGPT_REDIRECT] });
    expect(response.status).toBe(201);
    const clientId = ((await response.json()) as { client_id: string }).client_id;
    const flow = await accessToken({ clientId, redirectUri: CHATGPT_REDIRECT });
    expect(flow.consentHtml).toContain('not verified');
    const added = await mcp(flow.token, 'tools/call', addNode(worldName('oauth-chatgpt-dcr')));
    expect(added.tool).toMatchObject({ ok: true, nodes: [{ createdBy: { harness: 'chatgpt', actor: 'writer@example.com' } }] });
  });

  it('a refresh token yields a new access token for the same resource and scopes', async () => {
    const clientId = await registerClaudeAi();
    const flow = await accessToken({ clientId, redirectUri: CLAUDE_AI_CALLBACK });
    const refreshed = await tokenRequest({ grant_type: 'refresh_token', refresh_token: flow.tokenBody.refresh_token as string, client_id: clientId });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body).toMatchObject({ resource: RESOURCE, scope: 'world:read world:write' });
    expect((await mcp(refreshed.body.access_token as string, 'tools/list')).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Acceptance test 4 (R1.3, R4.2): audience binding
// ---------------------------------------------------------------------------

describe('Tokens are bound to https://world-edge.test/mcp', () => {
  const OTHER = 'https://other.test';
  const otherOptions: OAuthProviderOptions<Env> = {
    apiRoute: '/mcp',
    apiHandler: { fetch: async () => new Response('other resource ok') },
    defaultHandler: { fetch: async () => new Response('not found', { status: 404 }) },
    authorizeEndpoint: `${OTHER}/authorize`,
    tokenEndpoint: `${OTHER}/token`,
    scopesSupported: ['world:read', 'world:write', 'world:propose'],
    resourceMetadata: { resource: `${OTHER}/mcp`, authorization_servers: [OTHER] },
  };

  it('rejects with 401 a token another provider minted on the same KV for another resource', async () => {
    // A copy of env, so the second provider cannot set OAUTH_PROVIDER on the Worker's env.
    const env = { ...testEnv } as unknown as Env;
    const other = new OAuthProvider<Env>(otherOptions);
    const helpers = getOAuthApi(otherOptions, env);
    const client = await helpers.createClient({ redirectUris: ['https://client.example/cb'], tokenEndpointAuthMethod: 'none', clientName: 'Other' });
    const verifier = 'v'.repeat(64);
    const url = new URL(`${OTHER}/authorize`);
    for (const [k, v] of Object.entries({
      response_type: 'code', client_id: client.clientId, redirect_uri: 'https://client.example/cb',
      code_challenge: await s256(verifier), code_challenge_method: 'S256', state: 's', resource: `${OTHER}/mcp`,
    })) url.searchParams.set(k, v);
    const authRequest = await helpers.parseAuthRequest(new Request(url));
    // Props shaped exactly like this Worker's grants: only the audience differs.
    const { redirectTo } = await helpers.completeAuthorization({
      request: authRequest, userId: 'mallory', metadata: {}, scope: ['world:read', 'world:write'],
      props: { kind: 'oauth', harness: 'chatgpt', actor: 'mallory@example.com', sub: 'mallory', clientId: client.clientId },
    });
    const code = new URL(redirectTo).searchParams.get('code')!;
    const minted = await other.fetch(new Request(`${OTHER}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: 'https://client.example/cb', code_verifier: verifier, client_id: client.clientId }),
    }), env, createExecutionContext());
    const token = ((await minted.json()) as { access_token: string; resource: string });
    expect(token.resource).toBe(`${OTHER}/mcp`);
    // The token is valid where it belongs ...
    const there = await other.fetch(new Request(`${OTHER}/mcp`, { headers: { authorization: `Bearer ${token.access_token}` } }), env, createExecutionContext());
    expect(there.status).toBe(200);
    // ... and refused here, with nothing written.
    const worldId = worldName('foreign');
    const here = await mcp(token.access_token, 'tools/call', addNode(worldId));
    expect(here.status).toBe(401);
    expect(here.headers.get('www-authenticate')).toContain('error="invalid_token"');
    expect((await (await agentFor(worldId)).getWorldInfo()).counts.nodes).toBe(0);
  });

  it('refuses a /token request naming a foreign resource, and an /authorize request too', async () => {
    const clientId = await registerClaudeAi();
    const flow = await codeFlow({ clientId, redirectUri: CLAUDE_AI_CALLBACK });
    const code = new URL(flow.callbackResponse.headers.get('location')!).searchParams.get('code')!;
    const foreign = await tokenRequest({
      grant_type: 'authorization_code', code, redirect_uri: CLAUDE_AI_CALLBACK, code_verifier: flow.start.verifier, client_id: clientId,
      resource: 'https://other.test/mcp',
    });
    expect(foreign.status).toBe(400);
    expect(foreign.body.error).toBe('invalid_target');
    expect(foreign.body.access_token).toBeUndefined();

    const consent = await openConsent({ clientId, redirectUri: CLAUDE_AI_CALLBACK });
    expect(consent.response.status).toBe(200);
    const wrongResource = await SELF.fetch(
      `${ORIGIN}/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(CLAUDE_AI_CALLBACK)}&code_challenge=${await s256('x'.repeat(50))}&code_challenge_method=S256&state=st&resource=${encodeURIComponent('https://other.test/mcp')}`,
      { redirect: 'manual' },
    );
    // The client and redirect are valid, so the error goes back to the client, with iss.
    expect(wrongResource.status).toBe(302);
    const location = new URL(wrongResource.headers.get('location')!);
    expect(location.searchParams.get('error')).toBe('invalid_target');
    expect(location.searchParams.get('iss')).toBe(ORIGIN);
    expect(location.searchParams.get('code')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// R5: redirect allowlist
// ---------------------------------------------------------------------------

describe('Redirect allowlist', () => {
  it('refuses DCR when any redirect URI is not allowlisted', async () => {
    for (const redirect_uris of [['https://evil.example/cb'], [CLAUDE_AI_CALLBACK, 'https://evil.example/cb'], ['http://localhost:3000/callback'], ['https://chatgpt.com.evil.example/connector_platform_oauth_redirect']]) {
      const response = await registerClient({ client_name: 'Claude', redirect_uris });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: 'invalid_redirect_uri' });
    }
  });

  it('never redirects or issues a code for a CIMD client whose document lists only a non-allowlisted redirect', async () => {
    const evil = 'https://evil.example/oauth/client.json';
    const key = await signingKey();
    const upstream = mockUpstream({ key, cimd: { [evil]: { ...chatgptCimdDocument(), client_id: evil, client_name: 'ChatGPT', redirect_uris: ['https://evil.example/cb'] } } });
    const consent = await openConsent({ clientId: evil, redirectUri: 'https://evil.example/cb' });
    expect(upstream.cimdFetches).toContain(evil);
    expect(consent.response.status).toBe(400);
    expect(consent.response.headers.get('location')).toBeNull();
    expect(consent.handle).toBeNull();
    expect(consent.html).toContain('allowlist');
  });

  it('never redirects for a stored client whose redirect is not allowlisted, even for an OAuth error', async () => {
    // A client stored without going through /register (as if registered before the allowlist changed).
    const client = await kvHelpers().createClient({ redirectUris: ['https://elsewhere.example/cb'], tokenEndpointAuthMethod: 'none', clientName: 'Elsewhere' });
    const ok = await openConsent({ clientId: client.clientId, redirectUri: 'https://elsewhere.example/cb' });
    expect(ok.response.status).toBe(400);
    expect(ok.response.headers.get('location')).toBeNull();
    // Missing PKCE would normally redirect back with an error; not to a non-allowlisted URI.
    const noPkce = await SELF.fetch(`${ORIGIN}/authorize?response_type=code&client_id=${client.clientId}&redirect_uri=${encodeURIComponent('https://elsewhere.example/cb')}&state=s`, { redirect: 'manual' });
    expect(noPkce.status).toBe(400);
    expect(noPkce.headers.get('location')).toBeNull();
  });

  it('redirects an OAuth error back to an allowlisted client with iss', async () => {
    const clientId = await registerClaudeAi();
    const noPkce = await SELF.fetch(`${ORIGIN}/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(CLAUDE_AI_CALLBACK)}&state=s1`, { redirect: 'manual' });
    expect(noPkce.status).toBe(302);
    const location = new URL(noPkce.headers.get('location')!);
    expect(location.searchParams.get('error')).toBe('invalid_request');
    expect(location.searchParams.get('state')).toBe('s1');
    expect(location.searchParams.get('iss')).toBe(ORIGIN);
  });

  it('re-checks the allowlist when consent is approved: no Access redirect once the redirect is no longer allowed', async () => {
    const clientId = await registerClaudeAi();
    mockUpstream({ key: await signingKey() });
    const consent = await openConsent({ clientId, redirectUri: CLAUDE_AI_CALLBACK });
    expect(consent.response.status).toBe(200);
    const form = new URLSearchParams({ handle: consent.handle!, decision: 'approve', scope: 'world:read' });
    const response = await fetchWithEnv(ONLY_CHATGPT, `${ORIGIN}/authorize`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString(),
    }, consent.start.jar);
    expect(response.status).toBe(400);
    expect(response.headers.get('location')).toBeNull();
    expect(await response.text()).toContain('allowlist');
  });

  it('re-checks the allowlist at /callback: no Access token request and no code once the redirect is no longer allowed', async () => {
    const clientId = await registerClaudeAi();
    const key = await signingKey();
    let nonce = '';
    const upstream = mockUpstream({ key, idToken: async () => key.sign(accessClaims(nonce)) });
    const { start, accessRedirect } = await approveToAccess({ clientId, redirectUri: CLAUDE_AI_CALLBACK });
    nonce = accessRedirect.searchParams.get('nonce')!;
    const url = `${ORIGIN}/callback?code=access-code-1&state=${encodeURIComponent(accessRedirect.searchParams.get('state')!)}`;
    const response = await fetchWithEnv(ONLY_CHATGPT, url, {}, start.jar);
    expect(response.status).toBe(400);
    expect(response.headers.get('location')).toBeNull();
    expect(upstream.tokenRequests).toHaveLength(0);
  });

  it('renders locally, never redirecting, for an unknown client or an unregistered redirect', async () => {
    const unknown = await SELF.fetch(`${ORIGIN}/authorize?response_type=code&client_id=nope&redirect_uri=${encodeURIComponent(CLAUDE_AI_CALLBACK)}`, { redirect: 'manual' });
    expect(unknown.status).toBe(400);
    expect(unknown.headers.get('location')).toBeNull();
    const clientId = await registerClaudeAi();
    const unregistered = await openConsent({ clientId, redirectUri: CHATGPT_REDIRECT });
    expect(unregistered.response.status).toBe(400);
    expect(unregistered.response.headers.get('location')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// id_token checks, Deny and Access errors
// ---------------------------------------------------------------------------

function expectAccessDenied(response: Response, start: FlowStart) {
  expect(response.status).toBe(302);
  const location = new URL(response.headers.get('location')!);
  expect(`${location.origin}${location.pathname}`).toBe(start.redirectUri);
  expect(location.searchParams.get('error')).toBe('access_denied');
  expect(location.searchParams.get('state')).toBe(start.clientState);
  expect(location.searchParams.get('iss')).toBe(ORIGIN);
  expect(location.searchParams.get('code')).toBeNull();
}

describe('Access sign-in failures never produce a code', () => {
  const now = () => Math.floor(Date.now() / 1000);
  const cases: [string, (nonce: string) => Record<string, unknown>, ((key: SigningKey) => Promise<SigningKey>)?][] = [
    ['wrong issuer', (nonce) => accessClaims(nonce, { iss: 'https://test-team.cloudflareaccess.com/cdn-cgi/access/sso/oidc/other-client' })],
    ['wrong audience', (nonce) => accessClaims(nonce, { aud: ['other-client'] })],
    ['expired', (nonce) => accessClaims(nonce, { exp: now() - 3600 })],
    ['not yet valid', (nonce) => accessClaims(nonce, { nbf: now() + 3600 })],
    ['wrong nonce', () => accessClaims('not-the-nonce-not-the-nonce-not-the-nonce')],
    ['no nonce', (nonce) => ({ ...accessClaims(nonce), nonce: undefined })],
    ['missing email', (nonce) => ({ ...accessClaims(nonce), email: undefined })],
    ['blank email', (nonce) => accessClaims(nonce, { email: '  ' })],
    ['missing sub', (nonce) => ({ ...accessClaims(nonce), sub: undefined })],
  ];

  for (const [name, claims] of cases) {
    it(`id_token with ${name}: access_denied with iss, no code`, async () => {
      const clientId = await registerClaudeAi();
      const flow = await codeFlow({ clientId, redirectUri: CLAUDE_AI_CALLBACK, claims });
      expectAccessDenied(flow.callbackResponse, flow.start);
    });
  }

  it('id_token with a bad signature (same kid, different key): access_denied, no code', async () => {
    const published = await signingKey();
    const forger = await signingKey();
    const clientId = await registerClaudeAi();
    let nonce = '';
    mockUpstream({ key: published, idToken: async () => forger.sign(accessClaims(nonce), { kid: published.kid }) });
    const { start, accessRedirect } = await approveToAccess({ clientId, redirectUri: CLAUDE_AI_CALLBACK });
    nonce = accessRedirect.searchParams.get('nonce')!;
    expectAccessDenied(await callback(start, { code: 'c', state: accessRedirect.searchParams.get('state')! }), start);
  });

  it('id_token signed with HS256 or without kid: access_denied, no code', async () => {
    const key = await signingKey();
    for (const header of [{ alg: 'HS256' }, { kid: undefined }]) {
      const clientId = await registerClaudeAi();
      let nonce = '';
      mockUpstream({ key, idToken: async () => key.sign(accessClaims(nonce), header) });
      const { start, accessRedirect } = await approveToAccess({ clientId, redirectUri: CLAUDE_AI_CALLBACK });
      nonce = accessRedirect.searchParams.get('nonce')!;
      expectAccessDenied(await callback(start, { code: 'c', state: accessRedirect.searchParams.get('state')! }), start);
      vi.restoreAllMocks();
    }
  });

  it('a JWKS key that is not an RS256 verification key, or a signature that is not base64url: access_denied, not a 500', async () => {
    const variants: [Record<string, unknown>, boolean][] = [
      [{ use: 'enc' }, false],
      [{ alg: 'RS512' }, false],
      [{ key_ops: ['encrypt'] }, false],
      [{}, true], // a good key, but the signature segment is not base64url
    ];
    for (const [jwkPatch, badSignature] of variants) {
      const key = await signingKey();
      const published = { ...key, jwk: { ...key.jwk, ...jwkPatch } };
      const clientId = await registerClaudeAi();
      let nonce = '';
      mockUpstream({
        key: published,
        idToken: async () => {
          const token = await key.sign(accessClaims(nonce));
          return badSignature ? `${token.split('.').slice(0, 2).join('.')}.@@@` : token;
        },
      });
      const { start, accessRedirect } = await approveToAccess({ clientId, redirectUri: CLAUDE_AI_CALLBACK });
      nonce = accessRedirect.searchParams.get('nonce')!;
      expectAccessDenied(await callback(start, { code: 'c', state: accessRedirect.searchParams.get('state')! }), start);
      vi.restoreAllMocks();
    }
  });

  it('Access token endpoint failure: access_denied, no code', async () => {
    const clientId = await registerClaudeAi();
    mockUpstream({ key: await signingKey() }); // no idToken: the token endpoint answers 400
    const { start, accessRedirect } = await approveToAccess({ clientId, redirectUri: CLAUDE_AI_CALLBACK });
    expectAccessDenied(await callback(start, { code: 'c', state: accessRedirect.searchParams.get('state')! }), start);
  });

  it('Access returning error=access_denied: access_denied with iss, and no token request', async () => {
    const clientId = await registerClaudeAi();
    const upstream = mockUpstream({ key: await signingKey(), idToken: async () => 'unused' });
    const { start, accessRedirect } = await approveToAccess({ clientId, redirectUri: CLAUDE_AI_CALLBACK });
    expectAccessDenied(await callback(start, { error: 'access_denied', state: accessRedirect.searchParams.get('state')! }), start);
    expect(upstream.tokenRequests).toHaveLength(0);
  });

  it('Deny on the consent page: access_denied with state and iss, and no Access redirect', async () => {
    const clientId = await registerClaudeAi();
    const consent = await openConsent({ clientId, redirectUri: CLAUDE_AI_CALLBACK });
    const denied = await postConsent(consent.start, consent.handle!, 'deny', []);
    expectAccessDenied(denied, consent.start);
  });

  it('a callback replayed, or from another browser, renders locally and issues nothing', async () => {
    const clientId = await registerClaudeAi();
    const flow = await codeFlow({ clientId, redirectUri: CLAUDE_AI_CALLBACK });
    expect(flow.callbackResponse.status).toBe(302);
    const state = flow.accessRedirect.searchParams.get('state')!;
    const replay = await SELF.fetch(`${ORIGIN}/callback?code=access-code-1&state=${encodeURIComponent(state)}`, { redirect: 'manual' });
    expect(replay.status).toBe(400);
    expect(replay.headers.get('location')).toBeNull();
  });

  it('a consent POST without the browser binding cookie is refused', async () => {
    const clientId = await registerClaudeAi();
    const consent = await openConsent({ clientId, redirectUri: CLAUDE_AI_CALLBACK });
    consent.start.jar.cookies.clear();
    const response = await postConsent(consent.start, consent.handle!, 'approve', ['world:read']);
    expect(response.status).toBe(400);
    expect(response.headers.get('location')).toBeNull();
  });

  it('approving with no scope ticked is refused without using up the consent', async () => {
    const clientId = await registerClaudeAi();
    const consent = await openConsent({ clientId, redirectUri: CLAUDE_AI_CALLBACK });
    const none = await postConsent(consent.start, consent.handle!, 'approve', []);
    expect(none.status).toBe(400);
    mockUpstream({ key: await signingKey() });
    const retry = await postConsent(consent.start, consent.handle!, 'approve', ['world:read']);
    expect(retry.status).toBe(302);
    expect(retry.headers.get('location')).toContain(ACCESS_AUTHORIZATION_URL);
  });

  it('escapes client-controlled strings on the consent page', async () => {
    const response = await registerClient({ client_name: '<script>alert(1)</script>"\'&', redirect_uris: [CLAUDE_AI_CALLBACK] });
    const clientId = ((await response.json()) as { client_id: string }).client_id;
    const consent = await openConsent({ clientId, redirectUri: CLAUDE_AI_CALLBACK });
    expect(consent.html).not.toContain('<script>');
    expect(consent.html).toContain('&#60;script&#62;alert(1)&#60;/script&#62;&#34;&#39;&#38;');
    expect(consent.response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(consent.response.headers.get('x-frame-options')).toBe('DENY');
  });
});

// ---------------------------------------------------------------------------
// PKCE (R4.1, acceptance 3)
// ---------------------------------------------------------------------------

describe('PKCE with S256 is required of every client', () => {
  async function registerConfidential(): Promise<string> {
    const response = await registerClient({ client_name: 'Confidential', redirect_uris: [CLAUDE_AI_CALLBACK], token_endpoint_auth_method: 'client_secret_basic' });
    expect(response.status).toBe(201);
    return ((await response.json()) as { client_id: string }).client_id;
  }

  function expectPkceError(response: Response, state: string) {
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('location')!);
    expect(`${location.origin}${location.pathname}`).toBe(CLAUDE_AI_CALLBACK);
    expect(location.searchParams.get('error')).toBe('invalid_request');
    expect(location.searchParams.get('state')).toBe(state);
    expect(location.searchParams.get('iss')).toBe(ORIGIN);
    expect(location.searchParams.get('code')).toBeNull();
  }

  it('a confidential DCR client without code_challenge gets an invalid_request redirect with iss, not a consent page', async () => {
    const clientId = await registerConfidential();
    const response = await SELF.fetch(authorizeUrl({ clientId, redirectUri: CLAUDE_AI_CALLBACK, state: 'conf-1' }), { redirect: 'manual' });
    expectPkceError(response, 'conf-1');
    // With S256 the same client reaches the consent page.
    const withPkce = await openConsent({ clientId, redirectUri: CLAUDE_AI_CALLBACK });
    expect(withPkce.response.status).toBe(200);
    expect(withPkce.handle).toBeTruthy();
  });

  it('code_challenge_method=plain is refused for public and confidential clients', async () => {
    for (const clientId of [await registerClaudeAi(), await registerConfidential()]) {
      const url = new URL(authorizeUrl({ clientId, redirectUri: CLAUDE_AI_CALLBACK, state: 'plain-1' }));
      url.searchParams.set('code_challenge', 'p'.repeat(50));
      url.searchParams.set('code_challenge_method', 'plain');
      expectPkceError(await SELF.fetch(url, { redirect: 'manual' }), 'plain-1');
    }
  });

  it('a wrong code_verifier at /token gives invalid_grant and no token', async () => {
    const clientId = await registerClaudeAi();
    const flow = await codeFlow({ clientId, redirectUri: CLAUDE_AI_CALLBACK });
    const code = new URL(flow.callbackResponse.headers.get('location')!).searchParams.get('code')!;
    const wrong = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: CLAUDE_AI_CALLBACK, code_verifier: randomString(), client_id: clientId });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toBe('invalid_grant');
    expect(wrong.body.access_token).toBeUndefined();
  });
});

describe('Token lifetimes and consent defaults', () => {
  it('issues 1 hour access tokens on a grant that ends 7 days after sign-in', async () => {
    const clientId = await registerClaudeAi();
    const flow = await accessToken({ clientId, redirectUri: CLAUDE_AI_CALLBACK });
    expect(flow.tokenBody.expires_in).toBe(3600);
    const grants = await kvHelpers().listUserGrants(encodeURIComponent('access-user-1'), { limit: 1000 });
    const grant = grants.items.find((g) => g.clientId === clientId)!;
    expect(grant.expiresAt).toBeDefined();
    const lifetime = grant.expiresAt! - grant.createdAt;
    expect(lifetime).toBeGreaterThanOrEqual(7 * 24 * 3600);
    expect(lifetime).toBeLessThanOrEqual(7 * 24 * 3600 + 5);
  });

  it('refreshing does not extend the grant: its expiry is the same before and after a refresh', async () => {
    const clientId = await registerClaudeAi();
    const flow = await accessToken({ clientId, redirectUri: CLAUDE_AI_CALLBACK });
    const grantFor = async () => (await kvHelpers().listUserGrants(encodeURIComponent('access-user-1'), { limit: 1000 })).items.find((g) => g.clientId === clientId)!;
    const before = await grantFor();
    // Let the clock move so an extension would be visible.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const refreshed = await tokenRequest({ grant_type: 'refresh_token', refresh_token: flow.tokenBody.refresh_token as string, client_id: clientId });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.refresh_token).toBeTruthy();
    const after = await grantFor();
    expect(after.id).toBe(before.id);
    expect(after.expiresAt).toBe(before.expiresAt);
  });

  it('pre-ticks only world:read when the client asked for none of our scopes, and what it asked for otherwise', async () => {
    const clientId = await registerClaudeAi();
    const none = await openConsent({ clientId, redirectUri: CLAUDE_AI_CALLBACK, scope: '' });
    expect(none.html).toMatch(/value="world:read" checked/);
    expect(none.html).toMatch(/value="world:write">/);
    expect(none.html).toMatch(/value="world:propose">/);
    const asked = await openConsent({ clientId, redirectUri: CLAUDE_AI_CALLBACK, scope: 'world:write world:propose offline_access' });
    expect(asked.html).toMatch(/value="world:read">/);
    expect(asked.html).toMatch(/value="world:write" checked/);
    expect(asked.html).toMatch(/value="world:propose" checked/);
  });
});

describe('/callback when the client changed after consent', () => {
  it('a CIMD document that drops the redirect URI ends on a local page that clears the cookie, with no code', async () => {
    const key = await signingKey();
    const document = chatgptCimdDocument();
    let nonce = '';
    mockUpstream({ key, cimd: { [CHATGPT_CIMD]: document }, idToken: async () => key.sign(accessClaims(nonce)) });
    const { start, accessRedirect } = await approveToAccess({ clientId: CHATGPT_CIMD, redirectUri: CHATGPT_REDIRECT });
    nonce = accessRedirect.searchParams.get('nonce')!;
    document.redirect_uris = ['https://chatgpt.com/connector/oauth/other'];
    const response = await callback(start, { code: 'access-code-1', state: accessRedirect.searchParams.get('state')! });
    expect(response.status).toBe(400);
    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.getSetCookie().some((c) => c.startsWith('__Host-oauth-upstream-') && /max-age=0/i.test(c))).toBe(true);
  });

  it('a DCR client deleted after consent ends on a local page, with no code', async () => {
    const clientId = await registerClaudeAi();
    const key = await signingKey();
    let nonce = '';
    mockUpstream({ key, idToken: async () => key.sign(accessClaims(nonce)) });
    const { start, accessRedirect } = await approveToAccess({ clientId, redirectUri: CLAUDE_AI_CALLBACK });
    nonce = accessRedirect.searchParams.get('nonce')!;
    await kvHelpers().deleteClient(clientId);
    const response = await callback(start, { code: 'access-code-1', state: accessRedirect.searchParams.get('state')! });
    expect(response.status).toBe(400);
    expect(response.headers.get('location')).toBeNull();
  });
});

describe('ChatGPT with its real CIMD document shape', () => {
  async function realisticDocument() {
    const clientKey = await signingKey();
    const document = chatgptCimdDocument({
      token_endpoint_auth_method: 'private_key_jwt',
      token_endpoint_auth_methods_supported: ['none', 'private_key_jwt'],
      jwks: { keys: [{ ...clientKey.jwk, use: 'sig', alg: 'RS256' }] },
    });
    return { clientKey, document };
  }

  async function assertion(key: SigningKey, extra: Record<string, unknown> = {}) {
    const now = Math.floor(Date.now() / 1000);
    return key.sign({ iss: CHATGPT_CIMD, sub: CHATGPT_CIMD, aud: ORIGIN, iat: now, exp: now + 120, jti: crypto.randomUUID(), ...extra });
  }

  async function codeFor(document: Record<string, unknown>) {
    const flow = await codeFlow({ clientId: CHATGPT_CIMD, redirectUri: CHATGPT_REDIRECT, cimd: { [CHATGPT_CIMD]: document } });
    expect(flow.callbackResponse.status).toBe(302);
    return { start: flow.start, code: new URL(flow.callbackResponse.headers.get('location')!).searchParams.get('code')! };
  }

  it('completes as a public client with PKCE and no assertion', async () => {
    const { document } = await realisticDocument();
    const { start, code } = await codeFor(document);
    const token = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: CHATGPT_REDIRECT, code_verifier: start.verifier, client_id: CHATGPT_CIMD, resource: RESOURCE });
    expect(token.status).toBe(200);
    expect(token.body.resource).toBe(RESOURCE);
    const added = await mcp(token.body.access_token as string, 'tools/call', addNode(worldName('cimd-public')));
    expect(added.tool).toMatchObject({ ok: true, nodes: [{ createdBy: { harness: 'chatgpt' } }] });
  });

  it('completes with a valid private_key_jwt assertion, and refuses a forged one without falling back to none', async () => {
    const { clientKey, document } = await realisticDocument();
    const forger = await signingKey();
    const first = await codeFor(document);
    const forged = await tokenRequest({
      grant_type: 'authorization_code', code: first.code, redirect_uri: CHATGPT_REDIRECT, code_verifier: first.start.verifier, client_id: CHATGPT_CIMD,
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: await forger.sign({ iss: CHATGPT_CIMD, sub: CHATGPT_CIMD, aud: ORIGIN, exp: Math.floor(Date.now() / 1000) + 120, jti: crypto.randomUUID() }, { kid: clientKey.kid }),
    });
    expect(forged.status).toBe(401);
    expect(forged.body.error).toBe('invalid_client');
    expect(forged.body.access_token).toBeUndefined();

    const second = await codeFor(document);
    const signed = await tokenRequest({
      grant_type: 'authorization_code', code: second.code, redirect_uri: CHATGPT_REDIRECT, code_verifier: second.start.verifier, client_id: CHATGPT_CIMD,
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: await assertion(clientKey),
    });
    expect(signed.status).toBe(200);
    expect((await mcp(signed.body.access_token as string, 'tools/list')).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Scope enforcement (R1.3)
// ---------------------------------------------------------------------------

describe('Scopes are enforced per tool', () => {
  it('a world:read token can get_world but gets INSUFFICIENT_SCOPE on add_node and propose_canon, writing nothing', async () => {
    const clientId = await registerClaudeAi();
    const flow = await accessToken({ clientId, redirectUri: CLAUDE_AI_CALLBACK, approve: ['world:read'] });
    expect(flow.tokenBody.scope).toBe('world:read');
    const worldId = worldName('readonly');
    // Seed one node with a service token so propose_canon has a real target.
    const seeded = await mcp(testEnv.TEST_TOKENS.claude, 'tools/call', addNode(worldId));
    const node = (seeded.tool as { nodes: { id: string; version: number }[] }).nodes[0]!;

    const read = await mcp(flow.token, 'tools/call', { name: 'get_world', arguments: { worldId } });
    expect(read.body?.result?.isError).toBeFalsy();
    expect(read.tool).toMatchObject({ counts: { nodes: 1 } });

    const write = await mcp(flow.token, 'tools/call', addNode(worldId));
    expect(write.body?.result?.isError).toBe(true);
    expect(write.tool).toEqual({ ok: false, error: { code: 'INSUFFICIENT_SCOPE', message: expect.any(String), requiredScope: 'world:write' } });

    const propose = await mcp(flow.token, 'tools/call', {
      name: 'propose_canon',
      arguments: { worldId, title: 'Canon?', targets: [{ type: 'node', id: node.id, baseVersion: node.version }], rationale: 'r' },
    });
    expect(propose.body?.result?.isError).toBe(true);
    expect(propose.tool).toMatchObject({ ok: false, error: { code: 'INSUFFICIENT_SCOPE', requiredScope: 'world:propose' } });

    const agent = await agentFor(worldId);
    const info = await agent.getWorldInfo();
    expect(info.counts.nodes).toBe(1);
    expect(info.world.version).toBe(1);
    expect(await agent.listOps(0, 10)).toHaveLength(1);
  });

  it('a world:write token without world:propose cannot propose canon; with it, it can', async () => {
    const clientId = await registerClaudeAi();
    const writer = await accessToken({ clientId, redirectUri: CLAUDE_AI_CALLBACK, approve: ['world:read', 'world:write'] });
    const worldId = worldName('propose');
    const added = await mcp(writer.token, 'tools/call', addNode(worldId));
    const node = (added.tool as { nodes: { id: string; version: number }[] }).nodes[0]!;
    const args = { worldId, title: 'Canon?', targets: [{ type: 'node', id: node.id, baseVersion: node.version }], rationale: 'r' };
    expect((await mcp(writer.token, 'tools/call', { name: 'propose_canon', arguments: args })).tool).toMatchObject({ error: { code: 'INSUFFICIENT_SCOPE' } });

    const proposer = await accessToken({ clientId, redirectUri: CLAUDE_AI_CALLBACK, approve: ['world:read', 'world:write', 'world:propose'] });
    const proposed = await mcp(proposer.token, 'tools/call', { name: 'propose_canon', arguments: args });
    expect(proposed.tool).toMatchObject({ ok: true, nodes: [{ canon: { status: 'proposed' } }] });
  });

  it('keeps readOnlyHint annotations (R8) for OAuth clients', async () => {
    const clientId = await registerClaudeAi();
    const flow = await accessToken({ clientId, redirectUri: CLAUDE_AI_CALLBACK });
    const listed = await mcp(flow.token, 'tools/list');
    const tools = (listed.body as unknown as { result: { tools: { name: string; annotations: { readOnlyHint: boolean } }[] } }).result.tools;
    const hints = Object.fromEntries(tools.map((t) => [t.name, t.annotations.readOnlyHint]));
    expect(hints).toEqual({
      get_world: true, get_region: true, search: true,
      add_node: false, update_node: false, link: false, move: false, propose_canon: false, layout_region: false, import_whiteboard: false,
    });
  });
});

// ---------------------------------------------------------------------------
// R7: static bearer tokens stay service tokens only, and OAuth tokens stay on /mcp
// ---------------------------------------------------------------------------

describe('Static bearer tokens and OAuth tokens never cross over', () => {
  it('a static service token is not accepted at /token in any role', async () => {
    const clientId = await registerClaudeAi();
    const statik = testEnv.TEST_TOKENS.claude;
    const attempts = [
      tokenRequest({ grant_type: 'authorization_code', code: statik, redirect_uri: CLAUDE_AI_CALLBACK, code_verifier: 'v'.repeat(50), client_id: clientId }),
      tokenRequest({ grant_type: 'refresh_token', refresh_token: statik, client_id: clientId }),
      tokenRequest({ grant_type: 'client_credentials', client_id: clientId }, { authorization: `Bearer ${statik}` }),
      tokenRequest({ grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange', subject_token: statik, subject_token_type: 'urn:ietf:params:oauth:token-type:access_token', client_id: clientId }),
    ];
    for (const attempt of await Promise.all(attempts)) {
      expect(attempt.status).toBeGreaterThanOrEqual(400);
      expect(attempt.body.access_token).toBeUndefined();
    }
  });

  it('a static service token on /mcp acts as its service-token principal', async () => {
    const worldId = worldName('static');
    const added = await mcp(testEnv.TEST_TOKENS.codex, 'tools/call', addNode(worldId));
    expect(added.tool).toMatchObject({ ok: true, nodes: [{ createdBy: { harness: 'codex', actor: 'codex-test' } }] });
  });

  it('an OAuth access token does not authenticate the non-MCP routes', async () => {
    const clientId = await registerClaudeAi();
    const flow = await accessToken({ clientId, redirectUri: CLAUDE_AI_CALLBACK });
    const worldId = worldName('oauth-agents');
    const headers = { authorization: `Bearer ${flow.token}`, 'content-type': 'application/json' };
    expect((await SELF.fetch(`${ORIGIN}/agents/world-agent/${worldId}`, { headers })).status).toBe(401);
    expect((await SELF.fetch(`${ORIGIN}/media/sign`, { method: 'POST', headers, body: JSON.stringify({ worldId, filename: 'x.png', contentType: 'image/png' }) })).status).toBe(401);
  });

  it('the OAuth endpoints exist only on the public origin', async () => {
    const other = 'https://world-edge.other-host.test';
    expect((await SELF.fetch(`${other}/authorize?client_id=x`, { redirect: 'manual' })).status).toBe(404);
    expect((await SELF.fetch(`${other}/callback?state=x`, { redirect: 'manual' })).status).toBe(404);
    expect((await SELF.fetch(`${other}/token`, { method: 'POST', body: 'grant_type=refresh_token', headers: { 'content-type': 'application/x-www-form-urlencoded' } })).status).toBe(404);
    expect((await SELF.fetch(`${other}/register`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })).status).toBe(404);
  });

  it('a valid static service token on a host other than PUBLIC_ORIGIN gets 401 at /mcp', async () => {
    const init = {
      method: 'POST',
      headers: { authorization: `Bearer ${testEnv.TEST_TOKENS.claude}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    };
    const elsewhere = await SELF.fetch('https://world-edge.acct.workers.dev/mcp', init);
    expect(elsewhere.status).toBe(401);
    expect(elsewhere.headers.get('www-authenticate')).toContain('error="invalid_token"');
    expect((await SELF.fetch(`${ORIGIN}/mcp`, init)).status).toBe(200);
  });

  it('an OAuth access token on another host is refused (the audience names the public origin)', async () => {
    const clientId = await registerClaudeAi();
    const flow = await accessToken({ clientId, redirectUri: CLAUDE_AI_CALLBACK });
    const response = await SELF.fetch('https://world-edge.other-host.test/mcp', {
      method: 'POST',
      headers: { authorization: `Bearer ${flow.token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(response.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Acceptance test 7: no tool call over OAuth or bearer produces canon
// ---------------------------------------------------------------------------

describe('No MCP caller can produce canon', () => {
  it('canon is refused over OAuth (all scopes) and bearer, and propose_canon only proposes', async () => {
    const clientId = await registerClaudeAi();
    const flow = await accessToken({ clientId, redirectUri: CLAUDE_AI_CALLBACK, approve: ['world:read', 'world:write', 'world:propose'] });
    for (const token of [flow.token, testEnv.TEST_TOKENS.claude]) {
      const worldId = worldName('canon');
      const canon = { status: 'canon', ref: 'https://github.com/x/y/blob/main/z.md' };
      const added = await mcp(token, 'tools/call', addNode(worldId, { canon }));
      expect(added.status).toBe(200);
      expect(added.body?.error !== undefined || added.body?.result?.isError === true).toBe(true);

      const ok = await mcp(token, 'tools/call', addNode(worldId));
      const node = (ok.tool as { nodes: { id: string; version: number }[] }).nodes[0]!;
      const patched = await mcp(token, 'tools/call', { name: 'update_node', arguments: { worldId, id: node.id, baseVersion: node.version, patch: { canon } } });
      expect(patched.body?.error !== undefined || patched.body?.result?.isError === true).toBe(true);
      const proposed = await mcp(token, 'tools/call', {
        name: 'propose_canon',
        arguments: { worldId, title: 'Canon?', targets: [{ type: 'node', id: node.id, baseVersion: node.version }], rationale: 'r' },
      });
      expect(proposed.tool).toMatchObject({ ok: true });

      const nodes = (await (await agentFor(worldId)).getNodesById([node.id])) as { canon: { status: string } }[];
      expect(nodes.map((n) => n.canon.status)).toEqual(['proposed']);
      const info = await (await agentFor(worldId)).getWorldInfo();
      expect(info.counts.nodes).toBe(1);
    }
  });
});
