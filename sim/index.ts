// The simulation. Runs identically in the browser and in Node on the server —
// this module is the only implementation, there is no second copy.
//
// Rules that hold for everything under sim/:
//   - fixed 60Hz tick, time counted in integer ticks, never milliseconds
//   - no Math.random, no Date.now, no wall clock, no render deltas
//   - no Math.* beyond the engine-exact ones (see mathd.ts)
//   - 2D only. The renderer is 3D, the sim is not.

import { cos, sin } from './mathd.js';

export const TICK_HZ = 60;
export const DT = 1 / TICK_HZ;

/** A run may not exceed this. Guards replay of a hostile timeline. */
export const MAX_TICKS = 60 * 60 * 10; // 10 minutes

// Handling. Phase 1 exists to argue with these numbers.
export const ACCEL = 34;
export const BRAKE = 46;
export const DRAG = 1.1;
export const GRIP = 6.5;
export const STEER = 3.1;

export const Intent = {
  Left: 'left',
  Right: 'right',
  Accel: 'accel',
  Brake: 'brake',
} as const;
export type Intent = (typeof Intent)[keyof typeof Intent];

const BIT: Record<Intent, number> = { left: 1, right: 2, accel: 4, brake: 8 };
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
  const steer = ((s.held & BIT.right ? 1 : 0) - (s.held & BIT.left ? 1 : 0)) * bite;
  s.heading += steer * STEER * DT;

  const nfx = sin(s.heading);
  const nfz = cos(s.heading);
  s.vx = nfx * fwd + nfz * lat;
  s.vz = nfz * fwd - nfx * lat;
  s.x += s.vx * DT;
  s.z += s.vz * DT;
  s.tick++;
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
