import {
  Book,
  BookMarked,
  BookOpenText,
  CalendarClock,
  Castle,
  Clapperboard,
  Crown,
  DoorOpen,
  Flag,
  Gem,
  Globe,
  House,
  Image as ImageIcon,
  Map as MapIcon,
  MapPin,
  PawPrint,
  Shapes,
  StickyNote,
  Sun,
  User,
  type LucideIcon,
} from 'lucide-react';
import type { NodeKind } from '@starlight-agent-canvas/world';

/** Sentence-case label and a line glyph per kind. No emoji. */
export const KIND_META: Record<NodeKind, { label: string; plural: string; Icon: LucideIcon }> = {
  world: { label: 'World', plural: 'worlds', Icon: Globe },
  region: { label: 'Region', plural: 'regions', Icon: MapIcon },
  story: { label: 'Story', plural: 'stories', Icon: BookOpenText },
  book: { label: 'Book', plural: 'books', Icon: Book },
  chapter: { label: 'Chapter', plural: 'chapters', Icon: BookMarked },
  scene: { label: 'Scene', plural: 'scenes', Icon: Clapperboard },
  character: { label: 'Character', plural: 'characters', Icon: User },
  place: { label: 'Place', plural: 'places', Icon: MapPin },
  faction: { label: 'Faction', plural: 'factions', Icon: Flag },
  artifact: { label: 'Artifact', plural: 'artifacts', Icon: Gem },
  event: { label: 'Event', plural: 'events', Icon: CalendarClock },
  house: { label: 'House', plural: 'houses', Icon: House },
  gate: { label: 'Gate', plural: 'gates', Icon: DoorOpen },
  god: { label: 'God', plural: 'gods', Icon: Sun },
  godbeast: { label: 'Godbeast', plural: 'godbeasts', Icon: PawPrint },
  concept: { label: 'Concept', plural: 'concepts', Icon: Shapes },
  note: { label: 'Note', plural: 'notes', Icon: StickyNote },
  image: { label: 'Image', plural: 'images', Icon: ImageIcon },
};

export const CanonIcon = Crown;
export const PlaceholderIcon = Castle;

export function KindGlyph({ kind, size = 14 }: { kind: NodeKind; size?: number }) {
  const { Icon } = KIND_META[kind];
  return <Icon aria-hidden="true" size={size} strokeWidth={1.6} />;
}

export function countLine(byKind: Partial<Record<NodeKind, number>>, max = 4): string {
  return Object.entries(byKind)
    .filter(([, n]) => (n ?? 0) > 0)
    .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
    .slice(0, max)
    .map(([kind, n]) => `${(n ?? 0).toLocaleString('en-US')} ${n === 1 ? KIND_META[kind as NodeKind].label.toLowerCase() : KIND_META[kind as NodeKind].plural}`)
    .join(' · ');
}
