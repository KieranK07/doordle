import { describe, expect, it } from 'vitest';
import { BIT, initialState, step, type InputEvent } from '../sim/index.js';
import { allOrders, puzzleFor } from '../sim/puzzle.js';
import { dateInWindow, scoreAgainst, scoreRun } from './score.js';

const DATE = '2026-03-04';
const NOW = new Date('2026-03-04T12:00:00Z');
const PUZZLE = puzzleFor(DATE);
const HOME = PUZZLE.home;

/**
 * A completed run, built by teleporting between pins rather than driving. The
 * timeline is empty, so what is being tested is the verdict logic rather than
 * anyone's driving. Teleports are not reproducible by replay, so this run is
 * used for the cases that must be REJECTED.
 */
function finishTickByTeleport(): number {
  const s = initialState(PUZZLE);
  const all = allOrders(PUZZLE);
  const park = (pin: { x: number; z: number }) => {
    s.x = pin.x;
    s.z = pin.z;
    step(s, PUZZLE);
  };
  for (let guard = 0; guard < 20 && s.delivered !== all; guard++) {
    for (let i = 0; i < PUZZLE.orders.length; i++) {
      if (!(s.picked & (1 << i))) park(PUZZLE.restaurants[PUZZLE.orders[i].restaurant]);
    }
    for (let i = 0; i < PUZZLE.orders.length; i++) {
      const bit = 1 << i;
      if (s.picked & bit && !(s.delivered & bit)) park(PUZZLE.houses[PUZZLE.orders[i].house]);
    }
  }
  park(PUZZLE.home);
  return s.finishTick;
}

describe('date window', () => {
  it('accepts the local date on either side of UTC', () => {
    expect(dateInWindow('2026-03-03', NOW)).toBe(true);
    expect(dateInWindow('2026-03-04', NOW)).toBe(true);
    expect(dateInWindow('2026-03-05', NOW)).toBe(true);
  });

  it('rejects anything further out, or malformed', () => {
    // A future date would hand out a puzzle nobody should have yet; a stale one
    // lets a player grind a route they have already seen.
    expect(dateInWindow('2026-03-06', NOW)).toBe(false);
    expect(dateInWindow('2026-03-02', NOW)).toBe(false);
    expect(dateInWindow('2026-3-4', NOW)).toBe(false);
    expect(dateInWindow('not-a-date', NOW)).toBe(false);
    expect(dateInWindow('', NOW)).toBe(false);
  });
});

describe('scoring a submission', () => {
  const base = { date: DATE, inputEvents: [] as InputEvent[], claimedFinishTick: 100 };

  it('refuses a run that never finished', () => {
    // Driving forward for a while and claiming victory.
    const events: InputEvent[] = [{ tick: 0, action: 'accel', down: true }];
    const v = scoreRun({ date: DATE, inputEvents: events, claimedFinishTick: 600 }, HOME, NOW);
    expect(v).toEqual({ ok: false, reason: 'run did not finish' });
  });

  it('refuses an empty timeline claiming a time', () => {
    // The obvious cheat: send nothing, claim a world record.
    const v = scoreRun({ ...base, claimedFinishTick: 42 }, HOME, NOW);
    expect(v.ok).toBe(false);
  });

  it('refuses a timeline that really did finish but at another tick', () => {
    // Proof the claim is compared rather than believed: this run genuinely
    // completes, but only because the test teleported, so no replay of its
    // timeline can reproduce it.
    const real = finishTickByTeleport();
    expect(real).toBeGreaterThan(0);
    const v = scoreRun({ ...base, claimedFinishTick: real }, HOME, NOW);
    expect(v.ok).toBe(false);
  });

  it('refuses malformed timelines', () => {
    const cases: InputEvent[][] = [
      [{ tick: 5, action: 'accel', down: true }, { tick: 2, action: 'left', down: true }],
      [{ tick: -1, action: 'accel', down: true }],
      [{ tick: 1.5, action: 'accel', down: true }],
      [{ tick: 1, action: 'nitro' as never, down: true }],
    ];
    for (const inputEvents of cases) {
      const v = scoreRun({ ...base, inputEvents }, HOME, NOW);
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.reason).toContain('replay rejected');
    }
  });

  it('refuses absurd submissions outright', () => {
    expect(scoreRun({ ...base, date: '2026-01-01' }, HOME, NOW).ok).toBe(false);
    expect(scoreRun({ ...base, claimedFinishTick: 0 }, HOME, NOW).ok).toBe(false);
    expect(scoreRun({ ...base, claimedFinishTick: 9_999_999 }, HOME, NOW).ok).toBe(false);
    expect(scoreRun({ ...base, inputEvents: 'nope' as never }, HOME, NOW).ok).toBe(false);
  });

  it('scores the same submission identically every time', () => {
    // Whatever the verdict, it must not depend on when it was computed.
    const events: InputEvent[] = [{ tick: 0, action: 'accel', down: true }];
    const sub = { date: DATE, inputEvents: events, claimedFinishTick: 300 };
    const a = scoreRun(sub, HOME, NOW);
    const b = scoreRun(sub, HOME, new Date('2026-03-04T23:59:00Z'));
    expect(a).toEqual(b);
  });

  it('accepts a run that genuinely drove there', () => {
    // Without this the whole suite would pass on a scoreRun that always
    // rejected. A puzzle with no orders and home straight up the street from
    // HQ, so holding the throttle is a complete, honest run.
    const straight = {
      hq: { x: 0, z: 0 },
      home: { x: 0, z: 60 },
      restaurants: [],
      houses: [],
      orders: [],
    };
    const events: InputEvent[] = [{ tick: 0, action: 'accel', down: true }];

    // Play it for real to learn the finish tick, exactly as the client would.
    const s = initialState(straight);
    s.held = BIT.accel;
    let guard = 0;
    while (s.finishTick < 0 && guard++ < 600) step(s, straight);
    expect(s.finishTick).toBeGreaterThan(0);

    const good = scoreAgainst(straight, {
      date: DATE,
      inputEvents: events,
      claimedFinishTick: s.finishTick,
    });
    expect(good).toEqual({ ok: true, finishTick: s.finishTick, stateHash: expect.any(Number) });

    // And one tick either side of the truth is refused.
    for (const off of [-1, 1]) {
      const v = scoreAgainst(straight, {
        date: DATE,
        inputEvents: events,
        claimedFinishTick: s.finishTick + off,
      });
      expect(v.ok).toBe(false);
    }
  });
});
