import { NextResponse } from 'next/server';
import { readWorld, WorldNotFoundError } from '@/lib/world/world-files';

export const dynamic = 'force-dynamic';

export async function GET(_request: Request, context: { params: Promise<{ worldId: string }> }) {
  const { worldId } = await context.params;
  try {
    return NextResponse.json(await readWorld(worldId));
  } catch (error) {
    if (error instanceof WorldNotFoundError) return NextResponse.json({ error: error.message }, { status: 404 });
    // Detail (file paths, parse errors) stays in the server log, not the response.
    console.error(`World ${worldId} could not be read:`, error);
    return NextResponse.json({ error: 'World could not be read.' }, { status: 500 });
  }
}
