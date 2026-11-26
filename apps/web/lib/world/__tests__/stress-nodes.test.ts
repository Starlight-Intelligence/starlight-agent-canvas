import { describe, expect, it } from 'vitest';
import { parseStressNodes } from '../stress-nodes';

describe('parseStressNodes', () => {
  it('floors fractional values before clamping, so the count is always a whole number', () => {
    expect(parseStressNodes('2.9')).toBe(2);
    expect(parseStressNodes('1500.5')).toBe(1500);
    expect(parseStressNodes('99999.99')).toBe(99_999);
  });
  it('clamps to 1..100000 and defaults to 10000', () => {
    expect(parseStressNodes('0.4')).toBe(1);
    expect(parseStressNodes('-5')).toBe(1);
    expect(parseStressNodes('250000')).toBe(100_000);
    expect(parseStressNodes('Infinity')).toBe(100_000);
    expect(parseStressNodes('abc')).toBe(10_000);
    expect(parseStressNodes(undefined)).toBe(10_000);
  });
});
