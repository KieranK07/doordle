// The simulation. Runs identically in the browser and in Node on the server —
// this module is the only implementation, there is no second copy.
//
// Rules that hold for everything under sim/:
//   - fixed 60Hz tick, time counted in integer ticks, never milliseconds
//   - no Math.random, no Date.now, no wall clock, no render deltas
//   - no Math.* beyond the engine-exact ones (see mathd.ts)
//   - 2D only. The renderer is 3D, the sim is not.

import { CITY } from './city.js';
import { cos, sin } from './mathd.js';

export const TICK_HZ = 60;
export const DT = 1 / TICK_HZ;

/** A run may not exceed this. Guards replay of a hostile timeline. */
export const MAX_TICKS = 60 * 60 * 10; // 10 minutes

// Handling. Phase 1 exists to argue with these numbers.
// Top speed is ACCEL / DRAG, so DRAG is the top-end knob and ACCEL is the
// off-the-line punch. Lowering DRAG also lengthens the coast when you lift.
export const ACCEL = 34;
export const BRAKE = 46;
export const DRAG = 0.8;
export const GRIP = 6.5;
export const STEER = 3.1;

/** Collision radius. A circle, not the car's actual box. See resolveHits(). */
export const CAR_RADIUS = 1.5;

export const Intent = {
  Left: 'left',
  Right: 'right',
  Accel: 'accel',
  Brake: 'brake',
} as const;
export type Intent = (typeof Intent)[keyof typeof Intent];

/** Held-intent bits. Exported so the input adapter cannot drift from the sim. */
export const BIT: Record<Intent, number> = { left: 1, right: 2, accel: 4, brake: 8 };
const INTENTS = Object.keys(BIT) as Intent[];

/** What the client submits: intent edges only, never per-tick samples. */
export type InputEvent = { tick: number; action: Intent; down: boolean };

export type State = {
  tick: number;
  held: number;
  x: number;
  z: number;
  heading: number;
  vx: number;
  vz: number;
};

export function initialState(): State {
  return { tick: 0, held: 0, x: 0, z: 0, heading: 0, vx: 0, vz: 0 };
}

/** Advance exactly one tick. Mutates in place: this runs 36000 times a replay. */
export function step(s: State): void {
  const fx = sin(s.heading);
  const fz = cos(s.heading);
  const rx = fz;
  const rz = -fx;

  let fwd = s.vx * fx + s.vz * fz;
  let lat = s.vx * rx + s.vz * rz;

  if (s.held & BIT.accel) fwd += ACCEL * DT;
  if (s.held & BIT.brake) fwd -= BRAKE * DT;
  fwd -= fwd * DRAG * DT;
  lat -= lat * GRIP * DT;

  // Steering authority scales with speed, so a parked car cannot spin on the spot.
  const bite = Math.min(1, Math.abs(fwd) / 8);
  // Forward is (sin h, cos h), so the car's own right is (-cos h, sin h) and a
  // RISING heading swings it to the left. Left adds, right subtracts.
  const steer = ((s.held & BIT.left ? 1 : 0) - (s.held & BIT.right ? 1 : 0)) * bite;
  s.heading += steer * STEER * DT;

  const nfx = sin(s.heading);
  const nfz = cos(s.heading);
  s.vx = nfx * fwd + nfz * lat;
  s.vz = nfz * fwd - nfx * lat;
  s.x += s.vx * DT;
  s.z += s.vz * DT;
  resolveHits(s);
  s.tick++;
}

/**
 * Push the car out of any building it ended the tick inside, killing only the
 * velocity component pointing into the wall so it slides along the face rather
 * than stopping dead.
 *
 * ponytail: circle vs AABB, and a full scan of every building each tick. The
 * circle means corners round off slightly instead of catching; swap for an OBB
 * only if scraping past a doorway feels wrong. The scan is O(buildings) per
 * tick, fine at a few hundred, so add a uniform grid when a district pushes it
 * into the thousands.
 *
 * Tunnelling is not handled: at 0.7 units of travel per tick against buildings
 * ten units thick it cannot happen. It could if either number changed a lot.
 */
function resolveHits(s: State): void {
  for (const b of CITY) {
    const dx = s.x - b.x;
    const overlapX = b.hw + CAR_RADIUS - Math.abs(dx);
    if (overlapX <= 0) continue;
    const dz = s.z - b.z;
    const overlapZ = b.hd + CAR_RADIUS - Math.abs(dz);
    if (overlapZ <= 0) continue;

    // Eject along the shallower axis: that is the face it actually came through.
    if (overlapX < overlapZ) {
      s.x += dx < 0 ? -overlapX : overlapX;
      s.vx = 0;
    } else {
      s.z += dz < 0 ? -overlapZ : overlapZ;
      s.vz = 0;
    }
  }
}

/**
 * Replay an input timeline. This is the authoritative scoring path on the
 * server, so the timeline is untrusted: anything malformed throws rather than
 * quietly producing a time.
 */
export function replay(events: readonly InputEvent[], untilTick: number): State {
  if (!Number.isInteger(untilTick) || untilTick < 0 || untilTick > MAX_TICKS) {
    throw new Error(`bad finish tick: ${untilTick}`);
  }
  let last = -1;
  for (const e of events) {
    if (!Number.isInteger(e.tick) || e.tick < 0 || e.tick > untilTick) {
      throw new Error(`bad event tick: ${e.tick}`);
    }
    if (e.tick < last) throw new Error('events out of order');
    if (!INTENTS.includes(e.action)) throw new Error(`bad action: ${e.action}`);
    last = e.tick;
  }

  const s = initialState();
  let i = 0;
  while (s.tick < untilTick) {
    while (i < events.length && events[i].tick === s.tick) {
      const e = events[i++];
      if (e.down) s.held |= BIT[e.action];
      else s.held &= ~BIT[e.action];
    }
    step(s);
  }
  return s;
}

/** FNV-1a over the full state. The determinism test compares these. */
export function hashState(s: State): number {
  const f = new Float64Array([s.x, s.z, s.heading, s.vx, s.vz]);
  const b = new Uint8Array(f.buffer);
  let h = 0x811c9dc5;
  for (let i = 0; i < b.length; i++) {
    h = Math.imul(h ^ b[i], 0x01000193);
  }
  h = Math.imul(h ^ s.tick, 0x01000193);
  h = Math.imul(h ^ s.held, 0x01000193);
  return h >>> 0;
}
