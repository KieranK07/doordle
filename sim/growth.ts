// City growth (SPEC.md §3, Phase 7).
//
// Growth is triggered on playability, never on how full the house pool is. The
// number that matters is how long a run actually takes for the players at the
// edge, and it is computed from the optimal-route solver rather than from live
// times, so it is predictable months ahead and not skewed by bad drivers.
//
// Appending a ring is a code change (CITY_RINGS in sim/city.ts) followed by a
// deploy, so this module measures and reports; it never grows the city on its
// own. That is deliberate: the append has to be reviewed, because getting it
// wrong moves houses that players already own.

import { CITY_RINGS, DISTRICT_PITCH, type Pin } from './city.js';
import { puzzleFor } from './daily.js';
import { DISTRICTS, slotsIn, type District } from './district.js';
import { TICK_HZ } from './index.js';
import { shiftDate } from './puzzle.js';
import { solve } from './solver.js';

/**
 * The playability ceiling, in seconds. SPEC.md §3 sets it at five minutes and
 * says outright that it will need tuning, so it is a constant to move, not a
 * law. A player whose run blows past this is having a bad time no matter how
 * many houses are still free.
 */
export const GROWTH_LIMIT_S = 300;

/** Districts in the outermost ring: the players growth is meant to protect. */
export function outerDistricts(list: readonly District[] = DISTRICTS): District[] {
  const edge = Math.max(...list.map((d) => Math.max(Math.abs(d.gx), Math.abs(d.gz))));
  return list.filter((d) => Math.max(Math.abs(d.gx), Math.abs(d.gz)) === edge);
}

/** Corners first: the worst-served address in a district, so the sample is not flattering. */
function sampleHouses(d: District, per: number): Pin[] {
  const slots = slotsIn(d);
  const step = Math.max(1, Math.floor(slots.length / per));
  const out: Pin[] = [];
  for (let i = 0; i < slots.length && out.length < per; i += step) out.push(slots[i]);
  return out;
}

export type GrowthReport = {
  rings: number;
  districts: number;
  /** Mean optimal completion time for outer players, in seconds. */
  meanS: number;
  /** The worst single (day, house) pairing found, in seconds. */
  worstS: number;
  worstWhere: string;
  samples: number;
  grow: boolean;
};

/**
 * Measure how long a perfect run takes for players at the city edge, averaged
 * over a span of days and a spread of outer addresses.
 *
 * Every sample runs the solver, so this is seconds of work, not milliseconds.
 * It belongs in `npm run growth` and never in a request.
 */
export function growthReport(from: string, days = 9, housesPerDistrict = 3): GrowthReport {
  const outer = outerDistricts();
  let total = 0;
  let samples = 0;
  let worstS = 0;
  let worstWhere = '';

  for (let i = 0; i < days; i++) {
    const date = shiftDate(from, i);
    const puzzle = puzzleFor(date);
    for (const d of outer) {
      for (const home of sampleHouses(d, housesPerDistrict)) {
        // The route is the same for everyone; only the final leg home differs
        // (SPEC.md §5), which is exactly the asymmetry being measured.
        const seconds = solve({ ...puzzle, home }).ticks / TICK_HZ;
        total += seconds;
        samples++;
        if (seconds > worstS) {
          worstS = seconds;
          worstWhere = `${date} in ${d.name}`;
        }
      }
    }
  }

  const meanS = samples ? total / samples : 0;
  return {
    rings: CITY_RINGS,
    districts: DISTRICTS.length,
    meanS,
    worstS,
    worstWhere,
    samples,
    grow: meanS > GROWTH_LIMIT_S,
  };
}

/**
 * What appending one ring would add. Growth is append-only, so this is the
 * whole change: no existing district moves, and every claimed house keeps its
 * slot number because the pool is ordered by district (sim/puzzle.ts).
 */
export function nextRing(rings: number = CITY_RINGS): { districts: number; blocks: number } {
  const ring = rings + 1;
  const added = (ring * 2 + 1) ** 2 - (ring * 2 - 1) ** 2;
  return { districts: added, blocks: added * DISTRICT_PITCH ** 2 };
}
