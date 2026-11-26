import { NextResponse } from 'next/server';
import { LIMITS } from '@starlight-agent-canvas/world';
import { originDenied } from '@/lib/request-origin';
import { applyWorldOps, WorldNotFoundError } from '@/lib/world/world-files';

export const dynamic = 'force-dynamic';

/** Largest accepted request body. A full batch of LIMITS.opsPerBatchMax ops is far below this. */
const MAX_BODY_BYTES = 256 * 1024;

const tooLarge = (message: string) =>
  NextResponse.json({ ok: false, error: { code: 'INVALID_OP', message } }, { status: 413 });

/**
 * Applies a GraphOp batch to the local world. The browser has no authenticated
 * identity here, so every batch is stamped `harness: human`; agents write
 * through the L2 Worker, which stamps its own harness.
 */
export async function POST(request: Request, context: { params: Promise<{ worldId: string }> }) {
  const { worldId } = await context.params;
  // A page on another origin must not edit the local world. A text/plain JSON
  // body needs no CORS preflight, so check the origin explicitly against the
  // loopback hosts and WORLD_ALLOWED_ORIGINS (never the Host header), as the
  // checkpoint and website routes do, and require a JSON content type.
  if (originDenied(request)) {
    return NextResponse.json({ ok: false, error: { code: 'INVALID_OP', message: 'World edits require the workspace origin.' } }, { status: 403 });
  }
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    return NextResponse.json({ ok: false, error: { code: 'INVALID_OP', message: 'World edits must be sent as application/json.' } }, { status: 415 });
  }
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return tooLarge('World edit body exceeds 256 KB.');
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) return tooLarge('World edit body exceeds 256 KB.');
  let body: { ops?: unknown } | null = null;
  try {
    body = JSON.parse(text) as { ops?: unknown } | null;
  } catch {
    body = null;
  }
  if (!body || !Array.isArray(body.ops)) {
    return NextResponse.json({ ok: false, error: { code: 'INVALID_OP', message: 'Body must be { ops: GraphOp[] }.' } }, { status: 400 });
  }
  if (body.ops.length > LIMITS.opsPerBatchMax) return tooLarge(`A batch may contain at most ${LIMITS.opsPerBatchMax} ops.`);
  try {
    const result = await applyWorldOps(worldId, body.ops, 'human');
    if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: 409 });
    return NextResponse.json({ ok: true, version: result.graph.world.version, changed: result.changed, proposals: result.proposals });
  } catch (error) {
    if (error instanceof WorldNotFoundError) return NextResponse.json({ ok: false, error: { code: 'NOT_FOUND', message: error.message } }, { status: 404 });
    throw error;
  }
}
