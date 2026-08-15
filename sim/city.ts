// The city. Lives in sim/ because the car collides with it, so it has to be
// part of the deterministic state the server replays against, not scenery the
// renderer invents.
//
// This is still the Phase 1 placeholder: one hardcoded grid, generated from a
// fixed seed. Phase 2 replaces buildCity() with real district data loaded from
// JSON or the database. The shape of Building is what matters and should
// survive that swap.

import { makeRng, seedFrom } from './rng.js';

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
export const RING = 6;

/** Block centres, offset half a pitch so the origin is a street intersection. */
export function blockCentre(g: number): number {
  return (g + 0.5) * PITCH;
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
