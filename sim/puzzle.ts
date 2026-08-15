// A day's puzzle: where you start, what you pick up, where it goes, and where
// you finish. Deterministic from a seed, same for every player on a given day
// except `home`, which is the player's own house.
//
// Phase 6 replaces makePuzzle() with the real generator plus a validator that
// rejects anything outside the target time band. The shape below is what that
// generator has to produce.

import { BLOCK, RING, STREET, blockCentre } from './city.js';
import { makeRng, seedFrom } from './rng.js';

export type Pin = { x: number; z: number };

/** You must reach the restaurant before the house. */
export type Order = { restaurant: number; house: number };

export type Puzzle = {
  hq: Pin;
  /** The player's own house. The only part of the route that differs per player. */
  home: Pin;
  restaurants: Pin[];
  houses: Pin[];
  orders: Order[];
};

/** The precision-vs-frustration dial, SPEC.md §14. */
export const PIN_RADIUS = 3.5;
export const CARRY_LIMIT = 3;

const ORDER_COUNT = 7;
const RESTAURANT_COUNT = 4;

/**
 * Pins only appear within this many blocks of the centre. The city is much
 * bigger than one day's route: a puzzle spread over the whole grid takes far
 * longer than the 2-to-4 minute target in SPEC.md §4. This is the crude stand
 * in for "the route stays inside one district", which Phase 7 makes real.
 */
const PUZZLE_RING = 2;

/**
 * Every point where a pin can sit: the middle of the street alongside each
 * block face. Guarantees a pin is always somewhere the car can actually reach,
 * which a random point in the plane would not.
 */
function pinSlots(ring: number = PUZZLE_RING): Pin[] {
  const off = BLOCK / 2 + STREET / 2;
  const seen = new Set<string>();
  const out: Pin[] = [];
  for (let gx = -ring; gx <= ring; gx++) {
    for (let gz = -ring; gz <= ring; gz++) {
      const cx = blockCentre(gx);
      const cz = blockCentre(gz);
      for (const p of [
        { x: cx, z: cz - off },
        { x: cx, z: cz + off },
        { x: cx - off, z: cz },
        { x: cx + off, z: cz },
      ]) {
        const key = `${p.x},${p.z}`; // neighbouring blocks share a street
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(p);
      }
    }
  }
  return out;
}

export function makePuzzle(seed: number = seedFrom('doordle-phase2')): Puzzle {
  const rng = makeRng(seed);
  const pool = pinSlots();

  // Fisher-Yates, so every slot is equally likely and nothing repeats.
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = pool[i];
    pool[i] = pool[j];
    pool[j] = t;
  }

  let n = 0;
  const hq = pool[n++];
  const home = pool[n++];
  const restaurants = pool.slice(n, (n += RESTAURANT_COUNT));
  const houses = pool.slice(n, (n += ORDER_COUNT));

  // ponytail: every house gets one order from a random restaurant. Solvable by
  // construction and ignores the carry limit entirely, because any order set is
  // completable one at a time. Phase 6 is where difficulty gets designed.
  const orders: Order[] = houses.map((_, house) => ({
    restaurant: Math.floor(rng() * RESTAURANT_COUNT),
    house,
  }));

  return { hq, home, restaurants, houses, orders };
}

/**
 * The route for a given day, as YYYY-MM-DD. Every player gets this same puzzle;
 * only `home` differs, and the server swaps that in per account.
 *
 * There is deliberately no module-level "current puzzle". The server handles
 * many dates and many players at once, and a singleton would quietly hand
 * everyone whichever day happened to be loaded first.
 */
export function puzzleFor(date: string): Puzzle {
  return makePuzzle(seedFrom(`doordle:${date}`));
}

/**
 * Every position a player's house can be assigned to, across the whole city
 * rather than just the day's route.
 *
 * ponytail: the pool is derived from code, not stored. Slots are deterministic
 * and never move (SPEC.md §3 forbids it), so the database only has to remember
 * which ones are claimed. No seeding step, nothing to keep in sync.
 */
export function houseSlots(): Pin[] {
  return pinSlots(RING);
}

/** Local calendar date, since the puzzle unlocks at local midnight (§9). */
export function localDate(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = `${now.getMonth() + 1}`.padStart(2, '0');
  const d = `${now.getDate()}`.padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Bitmask with one bit per order, all set. */
export function allOrders(p: Puzzle): number {
  return (1 << p.orders.length) - 1;
}

export function countBits(mask: number): number {
  let n = 0;
  for (let m = mask; m; m >>= 1) n += m & 1;
  return n;
}
