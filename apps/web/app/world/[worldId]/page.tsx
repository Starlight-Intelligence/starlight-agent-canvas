import WorldCanvas from '@/components/world/WorldCanvas';

export default async function WorldPage({ params }: { params: Promise<{ worldId: string }> }) {
  const { worldId } = await params;
  return <WorldCanvas worldId={worldId} />;
}
