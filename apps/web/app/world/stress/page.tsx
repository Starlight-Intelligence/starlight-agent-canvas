import WorldCanvas from '@/components/world/WorldCanvas';
import { parseStressNodes } from '@/lib/world/stress-nodes';

/** 10k generated nodes by default; `?nodes=` overrides, capped at 100k. */
export default async function StressPage({ searchParams }: { searchParams: Promise<{ nodes?: string }> }) {
  const { nodes } = await searchParams;
  const n = parseStressNodes(nodes);
  return <WorldCanvas worldId="stress" stressNodes={n} />;
}
