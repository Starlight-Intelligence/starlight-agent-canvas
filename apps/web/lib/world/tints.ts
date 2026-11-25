/**
 * Region tints. Color lives in regions and imagery, never in chrome. Tints are
 * muted earth and sea tones; they render at 6 to 10 percent opacity. The gold
 * accent is not in this list: it is reserved for selection and canon.
 */
export const REGION_TINTS = ['#6f9a8d', '#a3785c', '#5d86a0', '#9c8a5e', '#8f8a6a', '#7c8f5a', '#a06a6a', '#5f8f8a'] as const;

/** Imported regions use authored colors. Pure gold tints would read as the accent, so they shift to amber clay. */
export function regionTint(color: string | undefined, index: number): string {
  if (!color) return REGION_TINTS[index % REGION_TINTS.length];
  const { h, s } = hueSat(color);
  // Saturated golds and yellows would compete with the selection accent.
  if (h >= 35 && h <= 60 && s > 0.45) return '#b08a5a';
  // Saturated cyans and blues read as the rejected AI glow; mute them to sea green.
  if (h >= 170 && h <= 260 && s > 0.6) return '#5f8f8a';
  return color;
}

export function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const r = Number.parseInt(h.slice(0, 2), 16);
  const g = Number.parseInt(h.slice(2, 4), 16);
  const b = Number.parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function hueSat(hex: string): { h: number; s: number } {
  const n = hex.replace('#', '');
  const r = Number.parseInt(n.slice(0, 2), 16) / 255;
  const g = Number.parseInt(n.slice(2, 4), 16) / 255;
  const b = Number.parseInt(n.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return { h: 0, s: 0 };
  const l = (max + min) / 2;
  const s = d / (1 - Math.abs(2 * l - 1));
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return { h, s };
}
