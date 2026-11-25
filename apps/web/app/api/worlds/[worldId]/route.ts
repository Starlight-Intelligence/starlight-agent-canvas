import { NextResponse } from 'next/server';
import { readWorld, WorldNotFoundError } from '@/lib/world/world-files';

export const dynamic = 'force-dynamic';

export async function GET(_request: Request, context: { params: Promise<{ worldId: string }> }) {
  const { worldId } = await context.params;
  try {
    return NextResponse.json(await readWorld(worldId));
  } catch (error) {
    if (error instanceof WorldNotFoundError) return NextResponse.json({ error: error.message }, { status: 404 });
    return NextResponse.json({ error: `World ${worldId} could not be read: ${error instanceof Error ? error.message : String(error)}` }, { status: 500 });
  }
}
