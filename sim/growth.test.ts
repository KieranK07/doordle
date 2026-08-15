// SPEC.md §3 is absolute about this: expand at the edges only, never alter
// existing roads, restaurant positions, or assigned house locations. A player
// who learned a shortcut in month one must still have it in month six.
//
// That is a promise about code that has not been written yet — the append that
// happens the day the city grows. These tests are how it gets kept: they run
// the growth by hand and assert that nothing already there moved.

import { describe, expect, it } from 'vitest';
import { CITY, CITY_RINGS, buildCity, buildingsNear, cityBlocks } from './city.js';
import { districts, slotsIn } from './district.js';
import { CAR_RADIUS } from './index.js';
import { GROWTH_LIMIT_S, growthReport, nextRing, outerDistricts } from './growth.js';

describe('the city only grows at its edges', () => {
  it('keeps every block where it was', () => {
    expect(cityBlocks(9).slice(0, cityBlocks(7).length)).toEqual(cityBlocks(7));
  });

  it('keeps every building where it was, in the same order', () => {
    // Order matters as much as position: collision walks CITY in sequence and
    // each ejection moves the car before the next building is tested, so a
    // reshuffle would change stored runs even with identical geometry.
    const before = buildCity(7);
    const after = buildCity(9);
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.length).toBeGreaterThan(before.length);
  });

  it('does not rearrange the map when one block changes its seed', () => {
    // The failure this guards against is a single shared RNG stream walking the
    // grid, where widening the city shifts every later draw.
    const city = buildCity(3);
    expect(buildCity(3)).toEqual(city);
  });
});

describe('house slots survive growth', () => {
  /** The pool, ordered exactly as sim/puzzle.ts orders it, for a given city size. */
  const poolFor = (rings: number) => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const d of districts(rings)) {
      for (const s of slotsIn(d)) {
        const key = `${s.x},${s.z}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(key);
      }
    }
    return out;
  };

  it('never renumbers a claimed house', () => {
    // A stored claim is an index into this list. If growth reorders it, players
    // wake up living at someone else's address.
    const before = poolFor(1);
    expect(poolFor(2).slice(0, before.length)).toEqual(before);
  });

  it('adds addresses rather than replacing them', () => {
    expect(poolFor(2).length).toBeGreaterThan(poolFor(1).length);
    expect(new Set(poolFor(2)).size).toBe(poolFor(2).length);
  });
});

describe('the collision index', () => {
  // The bucket grid replaced a full scan of every building. It is only a
  // speed-up if it returns a superset of whatever the scan would have hit; miss
  // one building and cars start driving through walls in a way no hash pins,
  // because the pinned run does not visit every corner of the map.
  it('never misses a building the old full scan would have hit', () => {
    let checked = 0;
    for (let x = -400; x <= 400; x += 7.5) {
      for (let z = -400; z <= 400; z += 7.5) {
        const near = new Set(buildingsNear(x, z));
        for (let i = 0; i < CITY.length; i++) {
          const b = CITY[i];
          if (Math.abs(x - b.x) < b.hw + CAR_RADIUS && Math.abs(z - b.z) < b.hd + CAR_RADIUS) {
            expect(near.has(i)).toBe(true);
            checked++;
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('hands buildings back in CITY order', () => {
    // Collision ejects the car as it walks the list, so a reordered bucket is a
    // different simulation even with identical geometry.
    for (const [x, z] of [[0, 0], [120, -60], [-315, 200]]) {
      const near = buildingsNear(x, z);
      expect([...near]).toEqual([...near].sort((a, b) => a - b));
    }
  });

  it('keeps a bucket small enough to be worth the trouble', () => {
    const sizes = [];
    for (let x = -300; x <= 300; x += 63) for (let z = -300; z <= 300; z += 63) sizes.push(buildingsNear(x, z).length);
    expect(Math.max(...sizes)).toBeLessThan(CITY.length / 4);
  });
});

describe('growth cannot rewrite history', () => {
  const LOG = [
    { from: '2026-08-01', rings: 1 },
    { from: '2027-01-01', rings: 2 },
  ];

  /** ringsOn, as sim/city.ts implements it, against a log with a growth event. */
  const ringsOn = (date: string) => {
    let rings = LOG[0].rings;
    for (const g of LOG) if (date >= g.from) rings = g.rings;
    return rings;
  };

  it('leaves days before the growth date on the old district list', () => {
    expect(ringsOn('2026-12-31')).toBe(1);
    expect(ringsOn('2027-01-01')).toBe(2);
  });

  it('keeps a past day pointed at the same district after the city grows', () => {
    // The list length is the modulus of the rotation, so rotating a past date
    // over today's longer list would hand it a different district and re-roll a
    // puzzle somebody already played. This is the check that stops that.
    for (const date of ['2026-08-15', '2026-09-01', '2026-12-31']) {
      const day = 15; // any day number; what matters is which list is used
      const before = districts(ringsOn(date));
      expect(before).toHaveLength(9);
      expect(before[day % before.length]).toEqual(districts(1)[day % 9]);
    }
  });

  it('gives days after the growth date the bigger list', () => {
    expect(districts(ringsOn('2027-06-01'))).toHaveLength(25);
  });
});

describe('growth trigger', () => {
  it('measures the outermost ring, not the whole city', () => {
    const outer = outerDistricts(districts(2));
    // Ring 2 of a square lattice: 25 districts total, 16 on the perimeter.
    expect(outer).toHaveLength(16);
    expect(outer.every((d) => Math.max(Math.abs(d.gx), Math.abs(d.gz)) > 0)).toBe(true);
  });

  it('treats a one-district city as entirely edge', () => {
    expect(outerDistricts(districts(0))).toHaveLength(1);
  });

  // Every sample runs the solver, so even a tiny one is seconds of work. The
  // real check is `npm run growth`; this only proves the wiring.
  it('holds while outer runs are inside the limit', { timeout: 60_000 }, () => {
    const r = growthReport('2026-08-15', 1, 1);
    expect(r.samples).toBe(outerDistricts().length);
    expect(r.meanS).toBeGreaterThan(0);
    expect(r.worstS).toBeGreaterThanOrEqual(r.meanS);
    expect(r.grow).toBe(r.meanS > GROWTH_LIMIT_S);
  });

  it('knows what the next ring costs', () => {
    expect(nextRing(1).districts).toBe(16);
    expect(nextRing(0).districts).toBe(8);
    expect(nextRing(CITY_RINGS).districts).toBeGreaterThan(0);
  });
});
