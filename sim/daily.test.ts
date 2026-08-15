import { describe, expect, it } from 'vitest';
import { PAR_MAX_S, PAR_MIN_S, puzzleFor, validate, validateQueue } from './daily.js';
import { DISTRICTS, districtFor, districts, hqOf, slotsIn } from './district.js';
import { TICK_HZ } from './index.js';
import { EPOCH, makePuzzle, puzzleNumber, shiftDate } from './puzzle.js';
import { seedFrom } from './rng.js';

describe('districts', () => {
  it('grows outward without moving anything already there', () => {
    // SPEC.md §3: expand at the edges only. A player who learned a shortcut in
    // month one must still have it in month six, so growth may only append.
    expect(districts(2).slice(0, districts(1).length)).toEqual(districts(1));
  });

  it('gives every district its own centre', () => {
    const list = districts(2);
    expect(new Set(list.map((d) => `${d.gx},${d.gz}`)).size).toBe(list.length);
  });

  it('pins each HQ to a street in its own district, not to the calendar', () => {
    for (const d of DISTRICTS) {
      const slots = new Set(slotsIn(d).map((s) => `${s.x},${s.z}`));
      const hq = hqOf(d);
      expect(slots.has(`${hq.x},${hq.z}`)).toBe(true);
      expect(hqOf(d)).toEqual(hq);
    }
  });

  it('rotates evenly over full cycles', () => {
    const list = districts(2);
    const counts = new Map<number, number>();
    for (let day = 0; day < list.length * 4; day++) {
      const id = districtFor(day, list).id;
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    expect([...counts.values()]).toEqual(list.map(() => 4));
  });

  it('handles day numbers from before the epoch', () => {
    const list = districts(2);
    expect(districtFor(-1, list)).toBe(list[list.length - 1]);
  });
});

describe('validator', () => {
  const DAY = '2026-08-15';

  it('passes a generated day', () => {
    const check = validate(puzzleFor(DAY), DAY);
    expect(check.problems).toEqual([]);
    expect(check.ok).toBe(true);
  });

  it('catches an order pointing at a restaurant that does not exist', () => {
    const p = puzzleFor(DAY);
    p.orders[0] = { restaurant: 99, house: 0 };
    expect(validate(p).problems).toContain('order 0: no such restaurant');
  });

  it('catches two pins stacked on one spot', () => {
    const p = puzzleFor(DAY);
    p.houses[1] = { ...p.houses[0] };
    expect(validate(p).ok).toBe(false);
  });

  it('catches a pin dumped off the street grid', () => {
    const p = puzzleFor(DAY);
    p.houses[0] = { x: 12.5, z: -7.25 };
    expect(validate(p).problems.some((s) => s.includes('not on a street'))).toBe(true);
  });

  it('rejects a route too short to be worth playing', () => {
    const p = puzzleFor(DAY);
    // One order, and the day still has to clear the band. Legal, solvable, and
    // not a game.
    p.orders = [{ restaurant: 0, house: 0 }];
    expect(validate(p).problems.some((s) => s.includes(`under ${PAR_MIN_S}s`))).toBe(true);
  });

  it('hands out a copy, so one caller cannot poison the day for the next', () => {
    const before = puzzleFor(DAY).orders[0].restaurant;
    const mine = puzzleFor(DAY);
    mine.orders[0].restaurant = (before + 1) % mine.restaurants.length;
    mine.flavor.orders[0].customer = 'Nobody';
    expect(puzzleFor(DAY).orders[0].restaurant).toBe(before);
    expect(puzzleFor(DAY).flavor.orders[0].customer).not.toBe('Nobody');
  });
});

describe('the queue', () => {
  // SPEC.md §12: a bad generation should never be a live incident. Generation is
  // a pure function of the date, so the buffer is a horizon that has been
  // checked rather than a table of rows. The span is fixed so this test cannot
  // change its own meaning as the calendar moves; `npm run queue` is what checks
  // the real upcoming days.
  const queue = validateQueue(EPOCH, 120);

  it('has no bad day in the first 120', () => {
    expect(queue.filter((c) => !c.ok).map((c) => `${c.date}: ${c.problems.join(', ')}`)).toEqual([]);
  });

  it('keeps every par inside the band', () => {
    for (const c of queue) {
      const seconds = c.par.ticks / TICK_HZ;
      expect(seconds).toBeGreaterThanOrEqual(PAR_MIN_S);
      expect(seconds).toBeLessThanOrEqual(PAR_MAX_S);
    }
  });

  it('does not serve the same route twice', () => {
    const seen = new Set(
      queue.map((c) => {
        const p = puzzleFor(c.date);
        return JSON.stringify([p.houses, p.restaurants, p.orders]);
      }),
    );
    expect(seen.size).toBe(queue.length);
  });

  it('builds the same queue every time', () => {
    expect(validateQueue(EPOCH, 10).map((c) => c.par.ticks)).toEqual(
      validateQueue(EPOCH, 10).map((c) => c.par.ticks),
    );
  });
});

describe('day numbering', () => {
  it('counts the epoch as day 1', () => {
    expect(puzzleNumber(EPOCH)).toBe(1);
    expect(puzzleNumber(shiftDate(EPOCH, 46))).toBe(47);
  });

  it('sends a date to the same district every time', () => {
    expect(puzzleFor('2026-08-15').district.id).toBe(puzzleFor('2026-08-15').district.id);
  });

  it('keeps flavor cosmetic', () => {
    // The scorer replays against the puzzle. If flavor ever reached the sim,
    // renaming a customer would change a stored time.
    const a = makePuzzle(seedFrom('x'));
    const b = makePuzzle(seedFrom('x'));
    b.flavor.orders[0].customer = 'Someone Else';
    expect(a.orders).toEqual(b.orders);
    expect(a.houses).toEqual(b.houses);
    expect(a.hq).toEqual(b.hq);
  });

  it('names every restaurant and every order', () => {
    const p = puzzleFor('2026-08-15');
    expect(new Set(p.flavor.restaurants).size).toBe(p.restaurants.length);
    expect(p.flavor.orders).toHaveLength(p.orders.length);
    for (const o of p.flavor.orders) expect(o.customer && o.item).toBeTruthy();
  });
});
