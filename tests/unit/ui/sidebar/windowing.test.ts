import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  offsetsOf,
  visibleRange,
} from '../../../../src/webview/ui/windowing';

describe('windowed lists', () => {
  it('says where each row starts', () => {
    expect(offsetsOf([22, 22, 10])).toEqual([0, 22, 44, 54]);
    expect(offsetsOf([])).toEqual([0]);
  });

  it('draws the rows a view touches, with some more on each side', () => {
    const offsets = offsetsOf(Array.from({ length: 100 }, () => 22));
    // Rows 45 (990px) to 49 (1100px) are in a 100px view from 1000px; two rows more on each side.
    expect(visibleRange(offsets, 1000, 100, 2)).toEqual({ start: 43, end: 53 });
    expect(visibleRange(offsets, 0, 220, 0)).toEqual({ start: 0, end: 11 });
  });

  it('keeps to the list at its ends', () => {
    const offsets = offsetsOf(Array.from({ length: 100 }, () => 22));
    expect(visibleRange(offsets, -50, 100, 8)).toEqual({ start: 0, end: 11 });
    expect(visibleRange(offsets, 5000, 600, 8)).toEqual({ start: 91, end: 100 });
    expect(visibleRange(offsetsOf([]), 0, 600)).toEqual({ start: 0, end: 0 });
  });

  it('follows rows of different heights', () => {
    // A 100px row (an expanded commit) between two 22px rows.
    const offsets = offsetsOf([22, 100, 22]);
    expect(visibleRange(offsets, 30, 10, 0)).toEqual({ start: 1, end: 2 });
  });
});
