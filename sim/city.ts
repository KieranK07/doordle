// The city. Lives in sim/ because the car collides with it, so it has to be
// part of the deterministic state the server replays against, not scenery the
// renderer invents.
//
// The geometry here is generated from a fixed seed rather than stored, which is
// allowed to stay true only as long as it never changes: SPEC.md §3 forbids
// moving a road, a restaurant or a claimed house once players have learned them.
// Growth appends districts at the edge, so CITY_RINGS is the only dial, and
// raising it must leave every existing coordinate exactly where it was.

import { makeRng, seedFrom } from './rng.js';

export type Pin = { x: number; z: number };

export type Building = {
  x: number;
  z: number;
  /** Half extents, so collision never has to divide. */
  hw: number;
  hd: number;
  /** Height. The sim ignores it; only the renderer cares. */
  h: number;
};

export const BLOCK = 46;
export const STREET = 17;
export const PITCH = BLOCK + STREET;

/** Blocks either side of a district's centre block, so a district is 5x5. */
export const DISTRICT_RING = 2;
/** Blocks between the centres of adjacent districts: they tile without a gap. */
export const DISTRICT_PITCH = DISTRICT_RING * 2 + 1;

/**
 * Rings of districts around the centre one. This is the growth dial (SPEC.md
 * §3, Phase 7): raising it appends a perimeter and leaves everything inside
 * untouched, because block coordinates are absolute.
 */
export const CITY_RINGS = 1;

/** Blocks from the origin to the city edge. Derived, so the two cannot disagree. */
export const RING = CITY_RINGS * DISTRICT_PITCH + DISTRICT_RING;

/** Block centres, offset half a pitch so the origin is a street intersection. */
export function blockCentre(g: number): number {
  return (g + 0.5) * PITCH;
}

/**
 * Every point a pin can sit on inside a block range: the middle of the street
 * alongside each block face. Guarantees a pin is always somewhere the car can
 * actually reach, which a random point in the plane would not.
 */
export function streetSlots(gx: number, gz: number, ring: number): Pin[] {
  const off = BLOCK / 2 + STREET / 2;
  const seen = new Set<string>();
  const out: Pin[] = [];
  for (let x = gx - ring; x <= gx + ring; x++) {
    for (let z = gz - ring; z <= gz + ring; z++) {
      const cx = blockCentre(x);
      const cz = blockCentre(z);
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

export function buildCity(seed: number = seedFrom('doordle-phase1-city')): Building[] {
  const rng = makeRng(seed);
  const out: Building[] = [];
  for (let gx = -RING; gx <= RING; gx++) {
    for (let gz = -RING; gz <= RING; gz++) {
      const cx = blockCentre(gx);
      const cz = blockCentre(gz);
      const cols = 2 + Math.floor(rng() * 2);
      const cell = BLOCK / cols;
      for (let i = 0; i < cols; i++) {
        for (let j = 0; j < cols; j++) {
          if (rng() < 0.18) continue; // gaps read as alleys, and are drivable
          const h = 6 + rng() * 30;
          const w = cell * (0.62 + rng() * 0.22);
          const d = cell * (0.62 + rng() * 0.22);
          out.push({
            x: cx - BLOCK / 2 + cell * (i + 0.5),
            z: cz - BLOCK / 2 + cell * (j + 0.5),
            hw: w / 2,
            hd: d / 2,
            h,
          });
        }
      }
    }
  }
  return out;
}

export const CITY: readonly Building[] = buildCity();
