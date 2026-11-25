import { slugify, worldIdSchema } from '@starlight-agent-canvas/world';
import { z } from 'zod';
import type { Principal } from './auth.js';
import type { Env } from './env.js';

/** Content types accepted for world media (images and manuscripts). */
export const MEDIA_CONTENT_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/avif',
  'application/pdf',
  'application/epub+zip',
  'text/markdown',
  'text/plain',
] as const;

export const MEDIA_MAX_BYTES = 50 * 1024 * 1024;
export const UPLOAD_TTL_SECONDS = 15 * 60;

export const signUploadInput = z.strictObject({
  worldId: worldIdSchema,
  filename: z.string().min(1).max(200),
  contentType: z.enum(MEDIA_CONTENT_TYPES),
});

const encoder = new TextEncoder();

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function canonical(key: string, exp: number, contentType: string, by: string): string {
  return ['world-edge-upload-v1', key, String(exp), contentType, by].join('\n');
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

/**
 * POST /media/sign (authenticated). Returns a short-lived URL the caller PUTs
 * the bytes to. The signature binds key, expiry, content type and uploader.
 */
export async function signUpload(request: Request, env: Env, principal: Principal, now = Date.now()): Promise<Response> {
  if (!env.WORLD_MEDIA || !env.MEDIA_SIGNING_KEY) {
    return json({ error: { code: 'MEDIA_DISABLED', message: 'WORLD_MEDIA or MEDIA_SIGNING_KEY is not configured.' } }, 503);
  }
  const parsed = signUploadInput.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return json({ error: { code: 'INVALID_INPUT', message: parsed.error.issues[0]?.message ?? 'Invalid input.' } }, 400);
  const { worldId, filename, contentType } = parsed.data;
  const dot = filename.lastIndexOf('.');
  const ext = dot > 0 ? slugify(filename.slice(dot + 1), 8) : '';
  const base = slugify(dot > 0 ? filename.slice(0, dot) : filename, 60) || 'file';
  const token = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  const key = `worlds/${worldId}/media/${token}-${base}${ext ? `.${ext}` : ''}`;
  const exp = Math.floor(now / 1000) + UPLOAD_TTL_SECONDS;
  const by = `${principal.harness}:${principal.actor}`;
  const sig = await hmacHex(env.MEDIA_SIGNING_KEY, canonical(key, exp, contentType, by));
  const url = new URL('/media/upload', request.url);
  url.searchParams.set('key', key);
  url.searchParams.set('exp', String(exp));
  url.searchParams.set('ct', contentType);
  url.searchParams.set('by', by);
  url.searchParams.set('sig', sig);
  return json({ key, uploadUrl: url.toString(), method: 'PUT', headers: { 'content-type': contentType }, expiresAt: new Date(exp * 1000).toISOString(), maxBytes: MEDIA_MAX_BYTES });
}

/** PUT /media/upload?key&exp&ct&by&sig. The signature is the credential. */
export async function receiveUpload(request: Request, env: Env, now = Date.now()): Promise<Response> {
  if (!env.WORLD_MEDIA || !env.MEDIA_SIGNING_KEY) {
    return json({ error: { code: 'MEDIA_DISABLED', message: 'WORLD_MEDIA or MEDIA_SIGNING_KEY is not configured.' } }, 503);
  }
  if (request.method !== 'PUT') return json({ error: { code: 'METHOD_NOT_ALLOWED', message: 'Use PUT.' } }, 405);
  const p = new URL(request.url).searchParams;
  const key = p.get('key') ?? '';
  const exp = Number(p.get('exp'));
  const ct = p.get('ct') ?? '';
  const by = p.get('by') ?? '';
  const sig = p.get('sig') ?? '';
  if (!/^worlds\/[A-Za-z0-9_-]+\/media\/[a-z0-9.-]+$/.test(key) || !Number.isFinite(exp) || !by || !/^[0-9a-f]{64}$/.test(sig)) {
    return json({ error: { code: 'BAD_SIGNATURE', message: 'Malformed upload URL.' } }, 403);
  }
  if (exp < Math.floor(now / 1000)) return json({ error: { code: 'EXPIRED', message: 'Upload URL expired.' } }, 403);
  const expected = await hmacHex(env.MEDIA_SIGNING_KEY, canonical(key, exp, ct, by));
  let diff = expected.length ^ sig.length;
  for (let i = 0; i < Math.min(expected.length, sig.length); i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  if (diff !== 0) return json({ error: { code: 'BAD_SIGNATURE', message: 'Signature does not match.' } }, 403);
  if ((request.headers.get('content-type') ?? '').split(';')[0]!.trim() !== ct) {
    return json({ error: { code: 'CONTENT_TYPE_MISMATCH', message: `Send content-type ${ct}.` } }, 400);
  }
  const length = Number(request.headers.get('content-length') ?? NaN);
  if (!Number.isFinite(length) || length <= 0 || length > MEDIA_MAX_BYTES) {
    return json({ error: { code: 'TOO_LARGE', message: `content-length must be 1..${MEDIA_MAX_BYTES}.` } }, 413);
  }
  if (!request.body) return json({ error: { code: 'EMPTY', message: 'No body.' } }, 400);
  const object = await env.WORLD_MEDIA.put(key, request.body, {
    httpMetadata: { contentType: ct },
    customMetadata: { uploadedBy: by },
    onlyIf: { etagDoesNotMatch: '*' },
  });
  if (!object) return json({ error: { code: 'EXISTS', message: 'Object already exists.' } }, 409);
  return json({ key, size: object.size, etag: object.etag });
}

/** GET /media/object/<key> (authenticated). */
export async function readMedia(request: Request, env: Env): Promise<Response> {
  if (!env.WORLD_MEDIA) return json({ error: { code: 'MEDIA_DISABLED', message: 'WORLD_MEDIA is not configured.' } }, 503);
  const key = decodeURIComponent(new URL(request.url).pathname.slice('/media/object/'.length));
  if (!key.startsWith('worlds/') || key.includes('..')) return json({ error: { code: 'NOT_FOUND', message: 'Not found.' } }, 404);
  const object = await env.WORLD_MEDIA.get(key);
  if (!object) return json({ error: { code: 'NOT_FOUND', message: 'Not found.' } }, 404);
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('cache-control', 'private, max-age=3600');
  headers.set('x-content-type-options', 'nosniff');
  return new Response(object.body, { headers });
}
