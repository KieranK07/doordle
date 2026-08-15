import { describe, expect, it } from 'vitest';
import { EPOCH, percentileOf, puzzleNumber, shiftDate, streakFrom } from './board.js';

describe('dates', () => {
  it('numbers the epoch as day 1', () => {
    expect(puzzleNumber(EPOCH)).toBe(1);
    expect(puzzleNumber('2026-08-15')).toBe(15);
  });

  it('crosses months and years', () => {
    expect(shiftDate('2026-03-01', -1)).toBe('2026-02-28');
    expect(shiftDate('2027-01-01', -1)).toBe('2026-12-31');
    expect(shiftDate('2026-08-15', -29)).toBe('2026-07-17');
  });

  // Every share card and every 30-day window is date arithmetic done in UTC. If
  // a DST-shifted local clock ever crept in, days would silently double or vanish.
  it('does not lose a day to daylight saving', () => {
    for (const d of ['2026-03-08', '2026-11-01']) {
      expect(shiftDate(shiftDate(d, -1), 1)).toBe(d);
      expect(puzzleNumber(shiftDate(d, 1)) - puzzleNumber(d)).toBe(1);
    }
  });
});

describe('percentile', () => {
  it('puts the winner in the top 1 percent, never zero', () => {
    expect(percentileOf(1, 10_000)).toBe(1);
  });

  it('reads the way the share card claims', () => {
    expect(percentileOf(6, 100)).toBe(6);
    expect(percentileOf(51, 1000)).toBe(6);
  });

  it('gives a lone player the whole field', () => {
    expect(percentileOf(1, 1)).toBe(100);
    expect(percentileOf(1, 0)).toBe(100);
  });
});

describe('streak', () => {
  const days = ['2026-08-15', '2026-08-14', '2026-08-13'];

  it('counts consecutive days back from today', () => {
    expect(streakFrom(days, '2026-08-15')).toBe(3);
  });

  it('stops at the first gap', () => {
    expect(streakFrom([...days, '2026-08-11'], '2026-08-15')).toBe(3);
  });

  it('is zero when today is unplayed', () => {
    expect(streakFrom(days, '2026-08-16')).toBe(0);
  });

  it('counts one for a first-ever run', () => {
    expect(streakFrom(['2026-08-15'], '2026-08-15')).toBe(1);
  });

  it('walks a streak across a month boundary', () => {
    expect(streakFrom(['2026-09-01', '2026-08-31', '2026-08-30'], '2026-09-01')).toBe(3);
  });
});
