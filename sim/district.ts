// Districts. Each day's route is set inside exactly one of them and starts at
// that district's own HQ, and which district hosts the day rotates (SPEC.md §3).
//
// Rotation is load-bearing rather than cosmetic: a route drawn uniformly across
// the whole map would leave outer houses permanently farther from the average
// route than central ones, which is a systematic penalty for late joiners
// instead of luck that comes round again. It also keeps a day's puzzle a tight,
// readable shape instead of a cross-city slog.

import {
  CITY_RINGS,
  DISTRICT_PITCH,
  DISTRICT_RING,
  streetSlots,
  type Pin,
} from './city.js';
import { makeRng, seedFrom } from './rng.js';

export type District = {
  id: number;
  /** Centre block of the district, in block coordinates. */
  gx: number;
  gz: number;
  name: string;
};

/**
 * Names are assigned by id and never reshuffled, because a district's name is
 * part of what players learn. Growth appends; it does not rename.
 */
const NAMES = [
  'Midtown', 'Harbourside', 'Ironworks', 'Kingsway', 'Fenwick',
  'Old Mill', 'Sable Row', 'Northgate', 'Verrano', 'Ashfield',
  'Clement Hill', 'Dockend', 'Bellhaven', 'Ravensworth', 'Stonecross',
  'Greyfriars', 'Lowbridge', 'Marchmont', 'Quarry End', 'Thornbury',
  'Alder Vale', 'Carrick', 'Denholm', 'Eastmoor', 'Foxglove',
];

/**
 * District centres in growth order: the middle one first, then a full ring at a
 * time. Appending a ring never moves an earlier district, which is what makes
 * "expand at the edges only" true at the data level rather than by convention.
 */
export function districts(rings: number = CITY_RINGS): District[] {
  const out: District[] = [];
  for (let r = 0; r <= rings; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        out.push({
          id: out.length,
          gx: dx * DISTRICT_PITCH,
          gz: dz * DISTRICT_PITCH,
          name: NAMES[out.length % NAMES.length],
        });
      }
    }
  }
  return out;
}

export const DISTRICTS: readonly District[] = districts();

/** Every pin position inside a district. */
export function slotsIn(d: District): Pin[] {
  return streetSlots(d.gx, d.gz, DISTRICT_RING);
}

/**
 * A district's HQ. Derived from the district id and nothing else, so it is
 * fixed the moment the district exists and never moves when the calendar or the
 * city changes. HQ is departure-only: you never come back to it (SPEC.md §4).
 */
export function hqOf(d: District): Pin {
  const slots = slotsIn(d);
  return slots[Math.floor(makeRng(seedFrom(`doordle:hq:${d.id}`))() * slots.length)];
}

/**
 * Which district hosts a given day. Straight round robin over day numbers, so
 * every district gets the same share of home-field days and the schedule is
 * knowable months ahead instead of drawn fresh each morning.
 *
 * ponytail: a plain modulo. When the city grows mid-rotation the sequence
 * shifts, which is harmless with equal shares; if growth ever needs to preserve
 * an in-flight order, store the schedule instead of deriving it.
 */
export function districtFor(day: number, list: readonly District[] = DISTRICTS): District {
  return list[((day % list.length) + list.length) % list.length];
}
