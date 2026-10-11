import { describe, expect, it } from 'vitest';
import { formatMemory, isMemoryShort } from '../../../src/features/workstreams/memory';

describe('the memory check', () => {
  it('is short only below the minimum (0 never asks for room)', () => {
    expect(isMemoryShort(1999, 2048)).toBe(true);
    expect(isMemoryShort(2048, 2048)).toBe(false);
    expect(isMemoryShort(0, 0)).toBe(false);
  });

  it('says sizes for people', () => {
    expect(formatMemory(900.4)).toBe('900 MB');
    expect(formatMemory(2048)).toBe('2.0 GB');
    expect(formatMemory(1536)).toBe('1.5 GB');
  });
});
