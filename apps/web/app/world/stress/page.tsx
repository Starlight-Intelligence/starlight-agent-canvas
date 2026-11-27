import WorldCanvas from '@/components/world/WorldCanvas';

/** 10k generated nodes by default; `?nodes=` overrides, capped at 100k. */
export default async function StressPage({ searchParams }: { searchParams: Promise<{ nodes?: string }> }) {
  const { nodes } = await searchParams;
  const n = Math.min(100_000, Math.max(1, Math.floor(Number(nodes)) || 10_000));
  return <WorldCanvas worldId="stress" stressNodes={n} />;
}
