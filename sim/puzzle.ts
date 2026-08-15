// A day's puzzle: where you start, what you pick up, where it goes, and where
// you finish. Deterministic from the date alone, same for every player on a
// given day except `home`, which is the player's own house.
//
// Nothing here is stored. The puzzle for any date, past or future, is a pure
// function of that date, which is what lets the queue be validated 30 days out
// (SPEC.md §12) with no rows to keep in sync and nothing to generate same-day.

import { type Pin } from './city.js';
import { DISTRICTS, hqOf, slotsIn, type District } from './district.js';
import { makeRng } from './rng.js';

export type { Pin };

/** You must reach the restaurant before the house. */
export type Order = { restaurant: number; house: number };

/**
 * Cosmetic only, and never read by the sim or the scorer. This is the slot the
 * optional LLM pass overwrites (SPEC.md §12 step 3); the deterministic strings
 * below are the fallback that ships when that pass is skipped or fails.
 */
export type Flavor = {
  restaurants: string[];
  orders: { customer: string; item: string }[];
};

export type Puzzle = {
  hq: Pin;
  /** The player's own house. The only part of the route that differs per player. */
  home: Pin;
  restaurants: Pin[];
  houses: Pin[];
  orders: Order[];
  district: District;
  flavor: Flavor;
};

/** The precision-vs-frustration dial, SPEC.md §14. */
export const PIN_RADIUS = 3.5;
export const CARRY_LIMIT = 3;

export const ORDER_COUNT = 7;
export const RESTAURANT_COUNT = 4;

// ---------------------------------------------------------------- the calendar

/** Day 1. Puzzle numbering, the district rotation and share cards all count from here. */
export const EPOCH = '2026-08-01';

const DAY = 86_400_000;
const stamp = (date: string) => Date.parse(`${date}T00:00:00Z`);

/** Day number for a date, counting the epoch as 1. */
export const puzzleNumber = (date: string) => Math.round((stamp(date) - stamp(EPOCH)) / DAY) + 1;

/** Date arithmetic in UTC, so a daylight-saving shift cannot add or eat a day. */
export function shiftDate(date: string, days: number): string {
  return new Date(stamp(date) + days * DAY).toISOString().slice(0, 10);
}

/** Local calendar date, since the puzzle unlocks at local midnight (§9). */
export function localDate(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = `${now.getMonth() + 1}`.padStart(2, '0');
  const d = `${now.getDate()}`.padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// ----------------------------------------------------------------- the flavor

// ponytail: two word lists and a seeded pick. Deterministic, offline, and good
// enough to give every order a name; the LLM pass in SPEC.md §12 replaces the
// strings and nothing else, because nothing downstream reads them.
const EATERIES = [
  'Golden Wok', 'Marlow Pizza', 'Halcyon Cafe', 'Bento Nine', 'Rosa Taqueria',
  'The Copper Kettle', 'Nonna Vale', 'Saffron House', 'Blue Anchor Fish Bar',
  'Pitmaster Row', 'Verde Salads', 'Sunrise Diner', 'Dumpling Lane', 'Kebab Koda',
];
const DISHES = [
  'pad thai', 'a double cheeseburger', 'chicken shawarma', 'two large pepperonis',
  'pho and spring rolls', 'a katsu curry', 'birria tacos', 'fish and chips',
  'a burrito bowl', 'six dumplings', 'a lamb gyro', 'shakshuka', 'wings and fries',
  'a chopped salad',
];
const CUSTOMERS = [
  'Amara', 'Beck', 'Cyrus', 'Dee', 'Elias', 'Fenn', 'Greta', 'Hollis', 'Idris',
  'Juno', 'Kaz', 'Lira', 'Moss', 'Nadia', 'Otto', 'Priya', 'Quill', 'Rune',
  'Soren', 'Tova', 'Ulla', 'Vesper', 'Wren', 'Xiu', 'Yusuf', 'Zadie',
];

const pick = <T>(list: readonly T[], rng: () => number) => list[Math.floor(rng() * list.length)];

function makeFlavor(seed: number, restaurants: number, orders: number): Flavor {
  const rng = makeRng(seed);
  // Sampled without replacement so no two restaurants share a name on the same
  // day; two customers sharing a first name is fine and reads as a real city.
  const pool = [...EATERIES];
  return {
    restaurants: Array.from({ length: restaurants }, () =>
      pool.splice(Math.floor(rng() * pool.length), 1)[0] ?? 'Unnamed Kitchen',
    ),
    orders: Array.from({ length: orders }, () => ({
      customer: pick(CUSTOMERS, rng),
      item: pick(DISHES, rng),
    })),
  };
}

// ---------------------------------------------------------------- the generator

/**
 * Build the puzzle for one district from one seed. Solvable by construction:
 * pins come from real street positions and every order is one restaurant to one
 * house, so any order set can be completed one at a time regardless of the
 * carry limit. The validator is what decides whether it is a *good* puzzle.
 */
export function makePuzzle(seed: number, district: District = DISTRICTS[0]): Puzzle {
  const rng = makeRng(seed);
  const pool = slotsIn(district);

  // Fisher-Yates, so every slot is equally likely and nothing repeats.
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = pool[i];
    pool[i] = pool[j];
    pool[j] = t;
  }

  // HQ is the district's own and is not drawn from the day's pool, so it is
  // fixed forever. Anything the day places on top of it is moved aside.
  const hq = hqOf(district);
  const free = pool.filter((p) => p.x !== hq.x || p.z !== hq.z);

  let n = 0;
  const home = free[n++];
  const restaurants = free.slice(n, (n += RESTAURANT_COUNT));
  const houses = free.slice(n, (n += ORDER_COUNT));

  const orders: Order[] = houses.map((_, house) => ({
    restaurant: Math.floor(rng() * RESTAURANT_COUNT),
    house,
  }));

  return {
    hq,
    home,
    restaurants,
    houses,
    orders,
    district,
    flavor: makeFlavor(seed ^ 0x5f5e1, RESTAURANT_COUNT, ORDER_COUNT),
  };
}

// The date-to-puzzle step lives in sim/daily.ts, not here: picking the day's
// draw means validating it, validating it means running the solver, and the
// solver reads this file. One direction only.

/**
 * Every position a player's house can be assigned to, across the whole city
 * rather than just the day's route.
 *
 * ponytail: the pool is derived from code, not stored. Slots are deterministic
 * and never move (SPEC.md §3 forbids it), so the database only has to remember
 * which ones are claimed. No seeding step, nothing to keep in sync.
 *
 * Ordered by district, in district growth order. A stored claim is an index into
 * this list, so the ordering is a permanent contract: walking the raw grid
 * instead would renumber every house the moment the city widened, and hand
 * players someone else's address. Districts append, so this only ever grows at
 * the end. It also packs the city centre-outwards for free.
 */
export function houseSlots(): Pin[] {
  const seen = new Set<string>();
  const out: Pin[] = [];
  for (const d of DISTRICTS) {
    for (const s of slotsIn(d)) {
      // Districts tile edge to edge, so a boundary street belongs to both. The
      // earlier district keeps it, which is stable under growth.
      const key = `${s.x},${s.z}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(s);
    }
  }
  return out;
}

/** Which district a house slot sits in, for the growth check. */
export function districtOfSlot(slot: number): District {
  const seen = new Set<string>();
  let n = 0;
  for (const d of DISTRICTS) {
    for (const s of slotsIn(d)) {
      const key = `${s.x},${s.z}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (n++ === slot) return d;
    }
  }
  throw new Error(`no such house slot: ${slot}`);
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
