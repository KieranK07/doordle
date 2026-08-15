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

import { CITY, PITCH } from './city.js';
import { CAR_RADIUS, TICK_HZ } from './index.js';
import { CARRY_LIMIT, allOrders, countBits, type Pin, type Puzzle } from './puzzle.js';

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

/**
 * Slack around the day's pins for the flood to route through. A day's route is
 * confined to one district, so the grid is built around those pins rather than
 * around the whole city: it stays the same size however far the city grows, and
 * one block pitch is more than a detour around a building ever needs.
 */
const MARGIN = PITCH;

type Grid = {
  cols: number;
  rows: number;
  minX: number;
  minZ: number;
  blocked: Uint8Array;
};

/** The walkable grid covering a set of pins, buildings fattened by the car. */
function gridFor(pins: readonly Pin[]): Grid {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const p of pins) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minZ = Math.min(minZ, p.z);
    maxZ = Math.max(maxZ, p.z);
  }
  minX -= MARGIN;
  minZ -= MARGIN;
  const cols = Math.floor((maxX + MARGIN - minX) / GRID_STEP) + 1;
  const rows = Math.floor((maxZ + MARGIN - minZ) / GRID_STEP) + 1;

  // Only the buildings that can reach into the box matter, which is what keeps
  // this cheap as the city grows past the district being solved.
  const near = CITY.filter(
    (b) =>
      b.x + b.hw + CAR_RADIUS > minX &&
      b.x - b.hw - CAR_RADIUS < minX + cols * GRID_STEP &&
      b.z + b.hd + CAR_RADIUS > minZ &&
      b.z - b.hd - CAR_RADIUS < minZ + rows * GRID_STEP,
  );

  const blocked = new Uint8Array(cols * rows);
  for (let cx = 0; cx < cols; cx++) {
    const wx = minX + cx * GRID_STEP;
    for (let cz = 0; cz < rows; cz++) {
      const wz = minZ + cz * GRID_STEP;
      for (const b of near) {
        if (Math.abs(wx - b.x) < b.hw + CAR_RADIUS && Math.abs(wz - b.z) < b.hd + CAR_RADIUS) {
          blocked[cx * rows + cz] = 1;
          break;
        }
      }
    }
  }
  return { cols, rows, minX, minZ, blocked };
}

/** Nearest cell the car could actually sit in, since pins sit mid-street. */
function nearestFree(g: Grid, p: Pin): number {
  const cx = Math.round((p.x - g.minX) / GRID_STEP);
  const cz = Math.round((p.z - g.minZ) / GRID_STEP);
  for (let r = 0; r < 8; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        const x = cx + dx;
        const z = cz + dz;
        if (x < 0 || z < 0 || x >= g.cols || z >= g.rows) continue;
        if (!g.blocked[x * g.rows + z]) return x * g.rows + z;
      }
    }
  }
  throw new Error(`pin at ${p.x},${p.z} is walled in`);
}

/** Flood from one cell, returning distance in world units to every cell. */
function flood(g: Grid, from: number): Float64Array {
  const n = g.cols * g.rows;
  const dist = new Float64Array(n).fill(Infinity);
  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;
  dist[from] = 0;
  queue[tail++] = from;
  while (head < tail) {
    const cur = queue[head++];
    const cx = (cur / g.rows) | 0;
    const cz = cur % g.rows;
    const next = dist[cur] + GRID_STEP;
    for (const [dx, dz] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const x = cx + dx;
      const z = cz + dz;
      if (x < 0 || z < 0 || x >= g.cols || z >= g.rows) continue;
      const i = x * g.rows + z;
      if (g.blocked[i] || dist[i] !== Infinity) continue;
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
export function solve(p: Puzzle): ParResult {
  const all = allOrders(p);
  const nR = p.restaurants.length;
  const nH = p.houses.length;

  // Node layout: HQ, restaurants, houses, home.
  const nodes: Pin[] = [p.hq, ...p.restaurants, ...p.houses, p.home];
  const HOME = nodes.length - 1;
  const grid = gridFor(nodes);
  const cells = nodes.map((n) => nearestFree(grid, n));
  const between: number[][] = cells.map((c) => {
    const d = flood(grid, c);
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
