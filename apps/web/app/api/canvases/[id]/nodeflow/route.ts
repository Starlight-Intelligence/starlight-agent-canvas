import { NextResponse } from 'next/server';
import { nodeflowRunRequestSchema } from '@starlight-agent-canvas/core';
import { getStore } from '@/lib/store';

export const runtime = 'nodejs';

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const manifest = await getStore().exportNodeflowBundle(id);
  return NextResponse.json({ manifest });
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const body = await request.json().catch(() => ({}));
  const parsed = nodeflowRunRequestSchema.parse(body);
  const outcome = await getStore().runNodeflow(id, parsed);
  return NextResponse.json(outcome);
}
