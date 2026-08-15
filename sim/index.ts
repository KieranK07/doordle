// The simulation. Runs identically in the browser and in Node on the server —
// this module is the only implementation, there is no second copy.
//
// Rules that hold for everything under sim/:
//   - fixed 60Hz tick, time counted in integer ticks, never milliseconds
//   - no Math.random, no Date.now, no wall clock, no render deltas
//   - no Math.* beyond the engine-exact ones (see mathd.ts)
//   - 2D only. The renderer is 3D, the sim is not.

import { CITY, buildingsNear } from './city.js';
import { cos, sin } from './mathd.js';
import { seedFrom } from './rng.js';
import { TRAFFIC_RADIUS, advanceTraffic, spawnTraffic, type Traffic } from './traffic.js';
import {
  CARRY_LIMIT,
  PIN_RADIUS,
  allOrders,
  countBits,
  type Pin,
  type Puzzle,
} from './puzzle.js';

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

/**
 * Clipping a traffic car costs you most of your momentum but never stops you
 * dead, per SPEC.md §6. The cooldown stops a single sustained overlap from
 * scrubbing speed every tick, which would be a full stop by another name.
 */
export const HIT_KEEP = 0.3;
export const HIT_COOLDOWN = 18;

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
  /** One bit per order, set when collected from its restaurant. */
  picked: number;
  /** One bit per order, set when dropped at its house. */
  delivered: number;
  /** Tick the car reached home with everything delivered, or -1 while running. */
  finishTick: number;
  traffic: Traffic;
  /** Ticks until another traffic hit can land. */
  hitCooldown: number;
};

export function initialState(p: Puzzle): State {
  return {
    tick: 0,
    held: 0,
    x: p.hq.x,
    z: p.hq.z,
    heading: 0,
    vx: 0,
    vz: 0,
    picked: 0,
    delivered: 0,
    finishTick: -1,
    traffic: spawnTraffic(seedFrom(`traffic:${p.hq.x},${p.hq.z}`), p.hq),
    hitCooldown: 0,
  };
}

/** Orders on board right now. */
export function carrying(s: State): number {
  return countBits(s.picked) - countBits(s.delivered);
}

/** Advance exactly one tick. Mutates in place: this runs 36000 times a replay. */
export function step(s: State, p: Puzzle): void {
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
  // Traffic advances after the player has moved but is never influenced by it,
  // which is what lets every player meet identical traffic.
  advanceTraffic(s.traffic);
  resolveTraffic(s);
  resolvePins(s, p);
  s.tick++;
}

/** Momentum loss on contact, not a stop. */
function resolveTraffic(s: State): void {
  if (s.hitCooldown > 0) {
    s.hitCooldown--;
    return;
  }
  const reach = CAR_RADIUS + TRAFFIC_RADIUS;
  for (const car of s.traffic.cars) {
    const dx = s.x - car.x;
    const dz = s.z - car.z;
    if (dx * dx + dz * dz > reach * reach) continue;
    // ponytail: scale the velocity and move on. No spin, no shunt, no damage to
    // the traffic car. Add a heading kick only if plowing through still beats
    // threading; that is the dial SPEC.md §6 asks to be tuned.
    s.vx *= HIT_KEEP;
    s.vz *= HIT_KEEP;
    s.hitCooldown = HIT_COOLDOWN;
    return;
  }
}

function atPin(s: State, pin: Pin): boolean {
  const dx = s.x - pin.x;
  const dz = s.z - pin.z;
  return dx * dx + dz * dz <= PIN_RADIUS * PIN_RADIUS;
}

/**
 * Pickups and dropoffs complete by driving through the pin. No button, no
 * required stop, per SPEC.md §4.
 *
 * Everything here is ordered by order index so two pins overlapping on the same
 * tick always resolve the same way.
 */
function resolvePins(s: State, p: Puzzle): void {
  if (s.finishTick >= 0) return;

  let load = carrying(s);
  for (let i = 0; i < p.orders.length; i++) {
    if (load >= CARRY_LIMIT) break; // full: nothing else can board this tick
    const bit = 1 << i;
    if (s.picked & bit) continue;
    if (!atPin(s, p.restaurants[p.orders[i].restaurant])) continue;
    s.picked |= bit;
    load++;
  }

  for (let i = 0; i < p.orders.length; i++) {
    const bit = 1 << i;
    if (!(s.picked & bit) || s.delivered & bit) continue;
    if (!atPin(s, p.houses[p.orders[i].house])) continue;
    s.delivered |= bit;
  }

  if (s.delivered === allOrders(p) && atPin(s, p.home)) s.finishTick = s.tick;
}

/**
 * Push the car out of any building it ended the tick inside, killing only the
 * velocity component pointing into the wall so it slides along the face rather
 * than stopping dead.
 *
 * ponytail: circle vs AABB. The circle means corners round off slightly instead
 * of catching; swap for an OBB only if scraping past a doorway feels wrong.
 *
 * Candidates come from the bucket grid in city.ts rather than a full scan,
 * which is what keeps a 36000-tick replay affordable as the city grows. The
 * bucket holds every building that could touch the car, in CITY order, so this
 * behaves exactly as the old scan did.
 *
 * Tunnelling is not handled: at 0.7 units of travel per tick against buildings
 * ten units thick it cannot happen. It could if either number changed a lot.
 */
function resolveHits(s: State): void {
  for (const i of buildingsNear(s.x, s.z)) {
    const b = CITY[i];
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
export function replay(
  events: readonly InputEvent[],
  untilTick: number,
  p: Puzzle,
): State {
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

  const s = initialState(p);
  let i = 0;
  while (s.tick < untilTick) {
    while (i < events.length && events[i].tick === s.tick) {
      const e = events[i++];
      if (e.down) s.held |= BIT[e.action];
      else s.held &= ~BIT[e.action];
    }
    step(s, p);
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
  // Traffic is deliberately not hashed. It is a pure function of the tick, and
  // if it ever diverged the player would collide differently, which moves the
  // position that is hashed. Hashing it too would only make the failure louder.
  for (const n of [s.tick, s.held, s.picked, s.delivered, s.finishTick, s.hitCooldown]) {
    h = Math.imul(h ^ n, 0x01000193);
  }
  return h >>> 0;
}
