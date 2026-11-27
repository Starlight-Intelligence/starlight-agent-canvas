import { NextResponse } from 'next/server';
import { nodeflowRunRequestSchema } from '@starlight-agent-canvas/core';
import { getStore } from '@/lib/store';
import { websiteErrorResponse, websiteOriginDenied, websiteRequestBody } from '@/lib/website-response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const manifest = await getStore().exportNodeflowBundle(id);
    return NextResponse.json({ manifest }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return websiteErrorResponse(error);
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const denied = websiteOriginDenied(request);
    if (denied) return denied;
    const { id } = await context.params;
    const raw = await websiteRequestBody(request);
    const parsed = nodeflowRunRequestSchema.parse(raw);
    // Browser HTTP route runs dry-run previews only; live provider calls and consent are never accepted from unauthenticated browser POSTs.
    const outcome = await getStore().runNodeflow(id, {
      nodeIds: parsed.nodeIds,
      mode: 'dry_run',
      maxCostUsd: parsed.maxCostUsd,
      consentVerified: false,
    });
    return NextResponse.json(outcome, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return websiteErrorResponse(error);
  }
}
