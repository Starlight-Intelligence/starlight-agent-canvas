import { NextResponse } from 'next/server';
import { applyWorldOps, WorldNotFoundError } from '@/lib/world/world-files';

export const dynamic = 'force-dynamic';

/**
 * Applies a GraphOp batch to the local world. The browser has no authenticated
 * identity here, so every batch is stamped `harness: human`; agents write
 * through the L2 Worker, which stamps its own harness.
 */
export async function POST(request: Request, context: { params: Promise<{ worldId: string }> }) {
  const { worldId } = await context.params;
  // A page on another origin must not edit the local world. A text/plain JSON
  // body needs no CORS preflight, so check the origin explicitly, as the
  // checkpoint and website routes do, and require a JSON content type.
  const origin = request.headers.get('origin');
  const expectedOrigin = `${new URL(request.url).protocol}//${request.headers.get('host')?.toLowerCase()}`;
  if (request.headers.get('sec-fetch-site') === 'cross-site' || (origin && origin !== expectedOrigin)) {
    return NextResponse.json({ ok: false, error: { code: 'INVALID_OP', message: 'World edits require the workspace origin.' } }, { status: 403 });
  }
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    return NextResponse.json({ ok: false, error: { code: 'INVALID_OP', message: 'World edits must be sent as application/json.' } }, { status: 415 });
  }
  const body = (await request.json().catch(() => null)) as { ops?: unknown } | null;
  if (!body || !Array.isArray(body.ops)) {
    return NextResponse.json({ ok: false, error: { code: 'INVALID_OP', message: 'Body must be { ops: GraphOp[] }.' } }, { status: 400 });
  }
  try {
    const result = await applyWorldOps(worldId, body.ops, 'human');
    if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: 409 });
    return NextResponse.json({ ok: true, version: result.graph.world.version, changed: result.changed, proposals: result.proposals });
  } catch (error) {
    if (error instanceof WorldNotFoundError) return NextResponse.json({ ok: false, error: { code: 'NOT_FOUND', message: error.message } }, { status: 404 });
    throw error;
  }
}
