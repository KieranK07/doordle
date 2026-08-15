// The daily pipeline (SPEC.md §12): generate, validate, queue.
//
// A day's puzzle is the first generation for that date that passes validation,
// so an unplayable or trivial draw is discarded before anyone sees it rather
// than shipped and apologised for. Generation is a pure function of the date,
// which means the "queue" is a horizon that has been checked rather than a
// table of rows waiting their turn, and nothing is ever generated same-day.
//
// This sits above the generator instead of inside it because validation needs
// the solver, and the solver needs the puzzle shape. One direction only.

import { districtFor, districtsOn, slotsIn } from './district.js';
import { TICK_HZ } from './index.js';
import {
  CARRY_LIMIT,
  ORDER_COUNT,
  RESTAURANT_COUNT,
  makePuzzle,
  puzzleNumber,
  shiftDate,
  type Puzzle,
} from './puzzle.js';
import { seedFrom } from './rng.js';
import { solve, type ParResult } from './solver.js';

/**
 * The par band, in seconds. SPEC.md §4 wants a good run in the 2-to-4 minute
 * range, and par is the optimal line that no real player drives, so the band
 * sits below the target rather than on it.
 *
 * ponytail: these are the calibration knobs and they are guesses until real run
 * times exist. Move them from playtest data, not from taste.
 */
export const PAR_MIN_S = 45;
export const PAR_MAX_S = 150;

/**
 * Redraws before giving up on a date. Days that need more than a handful are
 * rare; the cap only exists so a bad constant cannot spin forever.
 */
const MAX_ATTEMPTS = 40;

export type Check = { date: string; ok: boolean; par: ParResult; problems: string[] };

const same = (a: { x: number; z: number }, b: { x: number; z: number }) => a.x === b.x && a.z === b.z;

/** Every problem with a puzzle, not just the first, so one pass fixes the day. */
export function validate(p: Puzzle, date = ''): Check {
  const problems: string[] = [];

  if (p.orders.length !== ORDER_COUNT) problems.push(`expected ${ORDER_COUNT} orders, got ${p.orders.length}`);
  if (p.restaurants.length !== RESTAURANT_COUNT) problems.push(`expected ${RESTAURANT_COUNT} restaurants`);
  if (p.houses.length !== p.orders.length) problems.push('every order needs its own house');
  // Progress is tracked in a 32-bit mask (sim/index.ts), so an order count that
  // outgrew it would silently drop deliveries rather than fail loudly.
  if (p.orders.length > 30) problems.push('order count exceeds the progress bitmask');
  if (CARRY_LIMIT < 1) problems.push('carry limit must be at least 1');

  for (const [i, o] of p.orders.entries()) {
    if (o.restaurant < 0 || o.restaurant >= p.restaurants.length) problems.push(`order ${i}: no such restaurant`);
    if (o.house < 0 || o.house >= p.houses.length) problems.push(`order ${i}: no such house`);
  }

  // Two pins on one spot means one of them can never be visited separately, and
  // an order that starts where it ends is not a delivery.
  const pins = [
    ['hq', p.hq] as const,
    ...p.restaurants.map((r, i) => [`restaurant ${i}`, r] as const),
    ...p.houses.map((h, i) => [`house ${i}`, h] as const),
  ];
  for (let i = 0; i < pins.length; i++) {
    for (let j = i + 1; j < pins.length; j++) {
      if (same(pins[i][1], pins[j][1])) problems.push(`${pins[i][0]} and ${pins[j][0]} share a position`);
    }
  }

  // Everything the day places must sit on a real street position inside the
  // district hosting it, or the route stops being the tight local puzzle that
  // rotation exists to produce, and a pin can end up somewhere unreachable.
  const inDistrict = new Set(slotsIn(p.district).map((s) => `${s.x},${s.z}`));
  for (const [name, pin] of pins) {
    if (!inDistrict.has(`${pin.x},${pin.z}`)) problems.push(`${name} is not on a street in ${p.district.name}`);
  }

  // The solver throws when a pin is walled in or no route exists. That is the
  // right contract for the scorer, which must never invent a par, and the wrong
  // one here: the validator's whole job is to return a verdict on a bad puzzle
  // rather than take the process down with it.
  let par: ParResult = { ticks: Infinity, distance: Infinity };
  try {
    par = solve(p);
  } catch (e) {
    problems.push(`no route exists: ${(e as Error).message}`);
  }
  if (Number.isFinite(par.ticks)) {
    const seconds = par.ticks / TICK_HZ;
    if (par.ticks <= 0) problems.push('par is zero: the route goes nowhere');
    if (seconds < PAR_MIN_S) problems.push(`par ${seconds.toFixed(1)}s is under ${PAR_MIN_S}s`);
    if (seconds > PAR_MAX_S) problems.push(`par ${seconds.toFixed(1)}s is over ${PAR_MAX_S}s`);
  }

  return { date, ok: problems.length === 0, par, problems };
}

// ponytail: a plain Map, never evicted. Keys are dates and a Worker isolate
// sees a handful of them, so it cannot grow. Validation runs the solver, which
// is far too slow to repeat on every request.
const CACHE = new Map<string, Puzzle>();

/**
 * The route for a given day. Every player gets this same puzzle; only `home`
 * differs, and the server swaps that in per account.
 *
 * There is deliberately no module-level "current puzzle". The server handles
 * many dates and many players at once, and a singleton would quietly hand
 * everyone whichever day happened to be loaded first.
 */
export function puzzleFor(date: string): Puzzle {
  const hit = CACHE.get(date);
  // Cloned on the way out: callers treat the puzzle as theirs, and one of them
  // mutating a cached order would silently change the day for everyone after.
  if (hit) return structuredClone(hit);

  // The districts in service on that date, not the ones in service now: the
  // city may have grown since, and a past day has to stay the day it was.
  const district = districtFor(puzzleNumber(date), districtsOn(date));
  let puzzle = makePuzzle(seedFrom(`doordle:${date}:0`), district);
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const p = makePuzzle(seedFrom(`doordle:${date}:${attempt}`), district);
    if (validate(p).ok) {
      puzzle = p;
      break;
    }
  }
  // If nothing passed, the first draw ships anyway: a playable-but-off day beats
  // no game at all, and `npm run queue` is what shouts about it days ahead.
  CACHE.set(date, puzzle);
  return structuredClone(puzzle);
}

/**
 * The next `days` puzzles, validated. This is the buffer SPEC.md §12 asks to
 * keep at least 30 days deep, and the thing `npm run queue` prints.
 */
export function validateQueue(from: string, days = 30): Check[] {
  return Array.from({ length: days }, (_, i) => {
    const date = shiftDate(from, i);
    return validate(puzzleFor(date), date);
  });
}
