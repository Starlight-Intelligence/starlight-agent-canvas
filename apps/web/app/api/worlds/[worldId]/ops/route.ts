import { LIMITS } from '@starlight-agent-canvas/world';
import { NextResponse } from 'next/server';
import { readBodyLimited } from '@/lib/world/read-body';
import { applyWorldOps, WorldNotFoundError } from '@/lib/world/world-files';

export const dynamic = 'force-dynamic';

/** Largest accepted request body, enforced while streaming (no Content-Length needed). */
const MAX_BODY_BYTES = 256 * 1024;

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
  const text = await readBodyLimited(request, MAX_BODY_BYTES);
  if (text === null) {
    return NextResponse.json({ ok: false, error: { code: 'INVALID_OP', message: 'World edit body exceeds 256 KB.' } }, { status: 413 });
  }
  let body: { ops?: unknown } | null = null;
  try {
    body = JSON.parse(text) as { ops?: unknown } | null;
  } catch {
    body = null;
  }
  if (!body || !Array.isArray(body.ops)) {
    return NextResponse.json({ ok: false, error: { code: 'INVALID_OP', message: 'Body must be { ops: GraphOp[] }.' } }, { status: 400 });
  }
  // The byte cap alone admits thousands of small ops; cap the count with the
  // world package's own limit before taking the world lock or reading the file.
  if (body.ops.length > LIMITS.opsPerBatchMax) {
    return NextResponse.json({
      ok: false,
      error: {
        code: 'INVALID_OP',
        message: `A batch may hold at most ${LIMITS.opsPerBatchMax} ops; received ${body.ops.length}.`,
        limit: LIMITS.opsPerBatchMax,
        received: body.ops.length,
      },
    }, { status: 413 });
  }
  try {
    const result = await applyWorldOps(worldId, body.ops, 'human');
    if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: 409 });
    // The server's copy of what changed, so the browser adopts server versions and stamps.
    const changedNodes = new Set(result.changed.nodes);
    const changedEdges = new Set(result.changed.edges);
    return NextResponse.json({
      ok: true,
      version: result.graph.world.version,
      changed: result.changed,
      proposals: result.proposals,
      world: result.graph.world,
      nodes: result.graph.nodes.filter((n) => changedNodes.has(n.id)),
      edges: result.graph.edges.filter((e) => changedEdges.has(e.id)),
    });
  } catch (error) {
    if (error instanceof WorldNotFoundError) return NextResponse.json({ ok: false, error: { code: 'NOT_FOUND', message: error.message } }, { status: 404 });
    throw error;
  }
}
