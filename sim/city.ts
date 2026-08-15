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
 * When each ring of districts came into service. This is the growth dial
 * (SPEC.md §3, Phase 7).
 *
 * Growing is one appended row and a deploy. Never edit or remove an existing
 * row: the rotation picks each day's district out of the districts that existed
 * on that date, so rewriting history here would re-roll old puzzles and
 * invalidate every time already on the leaderboard. Date a new row past the end
 * of the validated queue so the days it changes have not been played yet.
 */
export const GROWTH_LOG: readonly { from: string; rings: number }[] = [
  { from: '2026-08-01', rings: 1 },
];

/** Rings the city has today. The geometry is built out to the largest of them. */
export const CITY_RINGS = Math.max(...GROWTH_LOG.map((g) => g.rings));

/** Rings that were in service on a given date. */
export function ringsOn(date: string): number {
  let rings = GROWTH_LOG[0].rings;
  for (const g of GROWTH_LOG) if (date >= g.from) rings = g.rings;
  return rings;
}

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

/**
 * Every block in the city, ordered ring by ring from the centre.
 *
 * The order is the point. Collision walks CITY in sequence and each ejection
 * moves the car before the next building is tested, so the array order is part
 * of the simulation contract, not an implementation detail. Ring order means
 * growth only ever appends: block 0 stays block 0 when the city doubles.
 */
export function cityBlocks(ring: number = RING): { gx: number; gz: number }[] {
  const out: { gx: number; gz: number }[] = [];
  for (let r = 0; r <= ring; r++) {
    for (let gx = -r; gx <= r; gx++) {
      for (let gz = -r; gz <= r; gz++) {
        if (Math.max(Math.abs(gx), Math.abs(gz)) === r) out.push({ gx, gz });
      }
    }
  }
  return out;
}

/**
 * Each block is seeded from its own coordinates rather than drawn from one
 * stream walking the grid. With a shared stream, widening the city shifts every
 * later draw and the whole map silently rearranges itself — which SPEC.md §3
 * forbids outright, since a shortcut learned in month one has to still be there
 * in month six.
 */
export function buildCity(ring: number = RING): Building[] {
  const out: Building[] = [];
  for (const { gx, gz } of cityBlocks(ring)) {
    const rng = makeRng(seedFrom(`doordle:block:${gx},${gz}`));
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
  return out;
}

export const CITY: readonly Building[] = buildCity();

// ------------------------------------------------------------ collision index

/**
 * Uniform bucket grid, one cell per block pitch, mapping a cell to the indices
 * of every building that could touch a car inside it.
 *
 * Collision used to scan all of CITY every tick, which was fine at a few
 * hundred buildings and stopped being fine the moment the city grew: a replay
 * is 36000 ticks and the server runs one per submitted run.
 *
 * The order of each bucket is ascending CITY index, and buildings are
 * registered with enough slack to cover the car plus the deepest ejection. That
 * makes the bucket a superset of whatever a full scan would have hit, visited
 * in the same order, so this is a speed-up and not a physics change — the
 * pinned CANON_HASH is what proves it.
 */
/**
 * Registration margin. Must stay comfortably above CAR_RADIUS plus the deepest
 * single ejection, or a building could touch the car without being in its
 * bucket. Declared here rather than imported because sim/index.ts imports this
 * file, so the dependency cannot run the other way; a test pins the two
 * together.
 */
const SLACK = 6;

const cellOf = (v: number) => Math.floor(v / PITCH);
/** Cell coordinates to one number, so the hot path allocates no strings. */
const cellKey = (cx: number, cz: number) => (cx + 1024) * 4096 + (cz + 1024);

const EMPTY: readonly number[] = [];

const CELLS = (() => {
  const map = new Map<number, number[]>();
  for (let i = 0; i < CITY.length; i++) {
    const b = CITY[i];
    for (let cx = cellOf(b.x - b.hw - SLACK); cx <= cellOf(b.x + b.hw + SLACK); cx++) {
      for (let cz = cellOf(b.z - b.hd - SLACK); cz <= cellOf(b.z + b.hd + SLACK); cz++) {
        const key = cellKey(cx, cz);
        let bucket = map.get(key);
        if (!bucket) map.set(key, (bucket = []));
        bucket.push(i);
      }
    }
  }
  return map;
})();

/** Indices into CITY of every building that could touch a car at this point. */
export function buildingsNear(x: number, z: number): readonly number[] {
  return CELLS.get(cellKey(cellOf(x), cellOf(z))) ?? EMPTY;
}
