// Par: how long the day's route takes if you drive it perfectly.
//
// Two halves. First, real travel distances between pins, found by flooding a
// grid that knows where the buildings are. Second, an exact search over the
// order in which pins can be visited, respecting the carry limit and the fact
// that you must reach a restaurant before its house.
//
// Par is what every score is measured against (SPEC.md §5), and the whole
// reason collision had to exist first: without walls the shortest path between
// two pins is a straight line and every number here would be a fantasy.

import { CITY } from './city.js';
import { CAR_RADIUS, TICK_HZ } from './index.js';
import { CARRY_LIMIT, PUZZLE, allOrders, countBits, type Pin, type Puzzle } from './puzzle.js';

/**
 * Metres per second a perfect driver averages, including everything the
 * distance model ignores: corners, acceleration out of them, and lining up for
 * a pin. Top speed is ACCEL/DRAG, well above this.
 *
 * ponytail: one calibration constant instead of simulating the optimal racing
 * line, which is a research project. It makes par uniformly optimistic rather
 * than wrong in a way that favours some routes over others. Tune it against
 * real playtest times: if good players consistently beat par, it is too low.
 */
export const PAR_SPEED = 28;

/**
 * ponytail: 4-connected flood on a coarse grid, so distances are Manhattan-ish.
 * That is close to true here because the roads are a grid, and it avoids
 * needing a priority queue at all. A city with diagonal roads or open plazas
 * would need 8-connected movement and a real Dijkstra.
 */
const GRID_STEP = 3.5;
const GRID_HALF = 260;
const COLS = Math.floor((GRID_HALF * 2) / GRID_STEP) + 1;

const toCell = (v: number) => Math.round((v + GRID_HALF) / GRID_STEP);
const toWorld = (c: number) => c * GRID_STEP - GRID_HALF;

/** Cells the car cannot occupy, buildings fattened by the car's radius. */
const blocked = (() => {
  const out = new Uint8Array(COLS * COLS);
  for (let cx = 0; cx < COLS; cx++) {
    const wx = toWorld(cx);
    for (let cz = 0; cz < COLS; cz++) {
      const wz = toWorld(cz);
      for (const b of CITY) {
        if (Math.abs(wx - b.x) < b.hw + CAR_RADIUS && Math.abs(wz - b.z) < b.hd + CAR_RADIUS) {
          out[cx * COLS + cz] = 1;
          break;
        }
      }
    }
  }
  return out;
})();

/** Nearest cell the car could actually sit in, since pins sit mid-street. */
function nearestFree(p: Pin): number {
  const cx = toCell(p.x);
  const cz = toCell(p.z);
  for (let r = 0; r < 8; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        const x = cx + dx;
        const z = cz + dz;
        if (x < 0 || z < 0 || x >= COLS || z >= COLS) continue;
        if (!blocked[x * COLS + z]) return x * COLS + z;
      }
    }
  }
  throw new Error(`pin at ${p.x},${p.z} is walled in`);
}

/** Flood from one cell, returning distance in world units to every cell. */
function flood(from: number): Float64Array {
  const dist = new Float64Array(COLS * COLS).fill(Infinity);
  const queue = new Int32Array(COLS * COLS);
  let head = 0;
  let tail = 0;
  dist[from] = 0;
  queue[tail++] = from;
  while (head < tail) {
    const cur = queue[head++];
    const cx = (cur / COLS) | 0;
    const cz = cur % COLS;
    const next = dist[cur] + GRID_STEP;
    for (const [dx, dz] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const x = cx + dx;
      const z = cz + dz;
      if (x < 0 || z < 0 || x >= COLS || z >= COLS) continue;
      const i = x * COLS + z;
      if (blocked[i] || dist[i] !== Infinity) continue;
      dist[i] = next;
      queue[tail++] = i;
    }
  }
  return dist;
}

export type ParResult = {
  /** Optimal time in ticks, the number scores are compared against. */
  ticks: number;
  /** Optimal driving distance in world units, before any speed assumption. */
  distance: number;
};

/**
 * Exact search over visit orders. Small enough to be exact: with seven orders
 * there are only a few hundred thousand reachable (picked, delivered, position)
 * states, so there is no reason to approximate.
 */
export function solve(p: Puzzle = PUZZLE): ParResult {
  const all = allOrders(p);
  const nR = p.restaurants.length;
  const nH = p.houses.length;

  // Node layout: HQ, restaurants, houses, home.
  const nodes: Pin[] = [p.hq, ...p.restaurants, ...p.houses, p.home];
  const HOME = nodes.length - 1;
  const cells = nodes.map(nearestFree);
  const between: number[][] = cells.map((c) => {
    const d = flood(c);
    return cells.map((other) => d[other]);
  });

  // cost[picked][delivered][node], in world units.
  const KEY_D = 4;
  const KEY_P = KEY_D + 7;
  const cost = new Float64Array((all + 1) << KEY_P).fill(Infinity);
  const key = (picked: number, delivered: number, node: number) =>
    (picked << KEY_P) | (delivered << KEY_D) | node;

  cost[key(0, 0, 0)] = 0;
  let best = Infinity;

  // Picked and delivered only ever gain bits, so ascending numeric order is a
  // valid processing order and no priority queue is needed.
  for (let picked = 0; picked <= all; picked++) {
    for (let delivered = 0; delivered <= picked; delivered++) {
      if (delivered & ~picked) continue; // cannot deliver what is not aboard
      for (let node = 0; node < nodes.length; node++) {
        const here = cost[key(picked, delivered, node)];
        if (here === Infinity) continue;

        if (delivered === all) {
          best = Math.min(best, here + between[node][HOME]);
          continue;
        }

        const load = countBits(picked) - countBits(delivered);

        // Drive through a restaurant: it loads every order it owes you, in
        // index order, until you are full. Matches resolvePins() exactly, and
        // the player has no say in it.
        for (let r = 0; r < nR; r++) {
          let take = picked;
          let room = CARRY_LIMIT - load;
          for (let i = 0; i < p.orders.length && room > 0; i++) {
            if (p.orders[i].restaurant !== r || take & (1 << i)) continue;
            take |= 1 << i;
            room--;
          }
          if (take === picked) continue; // nothing to collect, not worth a stop
          const to = 1 + r;
          const next = here + between[node][to];
          const k = key(take, delivered, to);
          if (next < cost[k]) cost[k] = next;
        }

        // Drive through a house: everything aboard for that house drops.
        for (let h = 0; h < nH; h++) {
          let drop = delivered;
          for (let i = 0; i < p.orders.length; i++) {
            if (p.orders[i].house !== h) continue;
            if (picked & (1 << i)) drop |= 1 << i;
          }
          if (drop === delivered) continue;
          const to = 1 + nR + h;
          const next = here + between[node][to];
          const k = key(picked, drop, to);
          if (next < cost[k]) cost[k] = next;
        }
      }
    }
  }

  if (!Number.isFinite(best)) throw new Error('puzzle has no solution');
  return { distance: best, ticks: Math.round((best / PAR_SPEED) * TICK_HZ) };
}
