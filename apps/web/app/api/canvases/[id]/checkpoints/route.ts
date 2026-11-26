import { NextResponse } from 'next/server';
import { getStore } from '@/lib/store';
import { checkpointErrorResponse } from '@/lib/checkpoint-response';
import { originDenied } from '@/lib/request-origin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    return NextResponse.json(await getStore().listCheckpoints(id), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return checkpointErrorResponse(error);
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    // A browser on another origin cannot create history in the local workspace.
    if (originDenied(request)) {
      return NextResponse.json({ error: 'Checkpoint saves require the workspace origin.' }, { status: 403 });
    }
    const { id } = await context.params;
    const checkpoint = await getStore().createCheckpoint(id, await request.json());
    return NextResponse.json({ checkpoint }, { status: 201, headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return checkpointErrorResponse(error);
  }
}
