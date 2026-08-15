// Traffic. Moving obstacles that drive the street grid, identical for every
// player on a given day (SPEC.md §6).
//
// Traffic never reads the player, only the tick and its own seeded RNG, so two
// players starting hours apart meet the same car in the same place at the same
// elapsed tick. That one-way dependency is what makes it replayable.

import { PITCH } from './city.js';
import { DT } from './index.js';

export const TRAFFIC_COUNT = 16;
export const TRAFFIC_SPEED = 15;
export const TRAFFIC_RADIUS = 1.7;

/** How far out traffic drives, in blocks, matching the puzzle area. */
const TRAFFIC_RING = 3;
const LIMIT = TRAFFIC_RING * PITCH;

/** 0 and 2 run along Z, 1 and 3 along X. */
const DIRS = [
  { x: 0, z: 1 },
  { x: 1, z: 0 },
  { x: 0, z: -1 },
  { x: -1, z: 0 },
];

export type Car = { x: number; z: number; dir: number };

/** mulberry32 as a pure step, so the generator state can live in sim state. */
function rand(state: number): { v: number; s: number } {
  let s = (state + 0x6d2b79f5) >>> 0;
  let t = s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return { v: ((t ^ (t >>> 14)) >>> 0) / 4294967296, s };
}

export type Traffic = { cars: Car[]; rng: number };

export function spawnTraffic(seed: number, keepClearOf: { x: number; z: number }): Traffic {
  let s = seed >>> 0;
  const next = () => {
    const r = rand(s);
    s = r.s;
    return r.v;
  };

  const cars: Car[] = [];
  let guard = 0;
  while (cars.length < TRAFFIC_COUNT && guard++ < TRAFFIC_COUNT * 40) {
    const dir = Math.floor(next() * 4);
    // One coordinate sits on a street line, the other runs along it.
    const line = (Math.floor(next() * (TRAFFIC_RING * 2 + 1)) - TRAFFIC_RING) * PITCH;
    const along = (next() * 2 - 1) * LIMIT;
    const car = dir % 2 === 0 ? { x: line, z: along, dir } : { x: along, z: line, dir };
    // Nobody spawns on top of the player's starting position.
    const dx = car.x - keepClearOf.x;
    const dz = car.z - keepClearOf.z;
    if (dx * dx + dz * dz < 40 * 40) continue;
    cars.push(car);
  }
  return { cars, rng: s };
}

/**
 * Advance every car one tick. Cars turn only at intersections and snap back to
 * the street line when they do, so they can never drift off the grid.
 *
 * ponytail: no lane offset, no car-to-car awareness, so traffic drives down the
 * middle and passes through itself. It is an obstacle field, not a simulation.
 * Give cars lanes and queueing only if the game ever needs them to look alive
 * rather than to be in the way.
 */
export function advanceTraffic(t: Traffic): void {
  for (const car of t.cars) {
    const d = DIRS[car.dir];
    const alongZ = car.dir % 2 === 0;
    const before = alongZ ? car.z : car.x;
    car.x += d.x * TRAFFIC_SPEED * DT;
    car.z += d.z * TRAFFIC_SPEED * DT;
    const after = alongZ ? car.z : car.x;

    const crossed = Math.floor(before / PITCH) !== Math.floor(after / PITCH);
    if (!crossed) continue;

    const node = Math.round(after / PITCH) * PITCH;
    const r = rand(t.rng);
    t.rng = r.s;

    let dir = car.dir;
    if (r.v < 0.26) dir = (dir + 1) & 3;
    else if (r.v < 0.52) dir = (dir + 3) & 3;

    // Turn back rather than drive out of the district. The test is "would this
    // take me further out", not "would this leave me outside": a car that is
    // already beyond the edge has to be allowed to drive back in, and an
    // earlier version that forbade both ratcheted cars outward forever.
    const px = alongZ ? car.x : node;
    const pz = alongZ ? node : car.z;
    const nd = DIRS[dir];
    const tx = px + nd.x * PITCH;
    const tz = pz + nd.z * PITCH;
    const outward =
      (Math.abs(tx) > LIMIT && Math.abs(tx) >= Math.abs(px)) ||
      (Math.abs(tz) > LIMIT && Math.abs(tz) >= Math.abs(pz));
    if (outward) dir = (dir + 2) & 3;

    if (dir !== car.dir) {
      // Snap onto the intersection so the new heading starts exactly on a line.
      if (alongZ) car.z = node;
      else car.x = node;
      car.dir = dir;
    }
  }
}
