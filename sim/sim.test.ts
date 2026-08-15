import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { cos, sin, wrapAngle } from './mathd.js';
import { makeRng, seedFrom } from './rng.js';
import { BIT, CAR_RADIUS, hashState, initialState, replay, step, type InputEvent } from './index.js';
import { CITY } from './city.js';
import { PI } from './mathd.js';
import { CANON_FINISH, CANON_HASH, CANON_TIMELINE } from './fixture.js';

// Every intent used, edges on odd ticks, overlapping holds.
const TIMELINE = CANON_TIMELINE;
const FINISH = CANON_FINISH;

describe('determinism', () => {
  it('is bit-identical across 1000 replays', () => {
    const want = hashState(replay(TIMELINE, FINISH));
    for (let i = 0; i < 1000; i++) {
      expect(hashState(replay(TIMELINE, FINISH))).toBe(want);
    }
  });

  it('actually simulated something', () => {
    // Guards the test above from passing on a sim that never moves, or a hash
    // that ignores the state it is handed.
    const s = replay(TIMELINE, FINISH);
    expect(s.tick).toBe(FINISH);
    expect(Math.abs(s.x) + Math.abs(s.z)).toBeGreaterThan(1);
    expect(hashState(s)).not.toBe(hashState(initialState()));
  });

  it('matches the pinned hash the browser also checks against', () => {
    // If this changes, physics changed. That is fine, but every stored run and
    // every leaderboard time computed under the old constants is now invalid.
    expect(hashState(replay(TIMELINE, FINISH))).toBe(CANON_HASH);
  });

  it('diverges on a one-tick input change', () => {
    const nudged = TIMELINE.map((e, i) => (i === 1 ? { ...e, tick: 38 } : e));
    expect(hashState(replay(nudged, FINISH))).not.toBe(hashState(replay(TIMELINE, FINISH)));
  });

  it('turns toward the side that was pressed', () => {
    // The bug this pins: `right` used to raise heading, which swings the car to
    // its LEFT given forward = (sin h, cos h). Invisible in a hash, obvious in a
    // car. Start facing +Z, so the car's own right is -X.
    // Short window on purpose: at STEER 3.1 the car comes all the way back
    // around in about two seconds, and a long sample measures nothing.
    const drive = (turn: number) => {
      const s = initialState();
      s.held = BIT.accel;
      for (let i = 0; i < 60; i++) step(s); // get up to speed, dead straight
      s.held = BIT.accel | turn;
      for (let i = 0; i < 12; i++) step(s);
      return s;
    };

    const r = drive(BIT.right);
    expect(r.heading).toBeLessThan(0);
    expect(r.vx).toBeLessThan(0); // veering toward -X, the car's own right
    expect(r.vz).toBeGreaterThan(0); // still mostly going forward

    const l = drive(BIT.left);
    expect(l.heading).toBeGreaterThan(0);
    expect(l.vx).toBeGreaterThan(0);
  });

  it('replaying tick by tick matches replaying in one call', () => {
    const s = initialState();
    s.held = BIT.accel;
    for (let i = 0; i < 120; i++) step(s);
    const one = hashState(s);

    const t = initialState();
    t.held = BIT.accel;
    for (let i = 0; i < 60; i++) step(t);
    for (let i = 0; i < 60; i++) step(t);
    expect(hashState(t)).toBe(one);
  });
});

describe('collision', () => {
  const inside = (x: number, z: number) =>
    CITY.some(
      (b) => Math.abs(x - b.x) < b.hw + CAR_RADIUS - 1e-6 && Math.abs(z - b.z) < b.hd + CAR_RADIUS - 1e-6,
    );

  it('never leaves the car inside a building', () => {
    // Aim at a building's face from just outside it and hold the throttle down.
    const b = CITY[0];
    for (const [dx, dz, heading] of [
      [0, -(b.hd + 4), 0],
      [0, b.hd + 4, PI],
      [-(b.hw + 4), 0, PI / 2],
    ]) {
      const s = initialState();
      s.x = b.x + dx;
      s.z = b.z + dz;
      s.heading = heading;
      s.held = BIT.accel;
      for (let i = 0; i < 240; i++) {
        step(s);
        expect(inside(s.x, s.z)).toBe(false);
      }
    }
  });

  it('slides along a wall instead of stopping dead', () => {
    // Into the face at an angle: the wall-normal speed dies, the rest survives.
    // It survives slowly, because a car still pointed at the wall is skidding
    // sideways and grip scrubs that off. Travel is the claim here, not speed.
    const b = CITY[0];
    const s = initialState();
    s.x = b.x;
    s.z = b.z - (b.hd + 4);
    s.heading = 0.5; // angled into the face, not square on
    s.held = BIT.accel;
    const startX = s.x;
    for (let i = 0; i < 180; i++) step(s);
    expect(s.x - startX).toBeGreaterThan(5);
    expect(s.vz).toBe(0);
  });

  it('leaves a car driving down an open street alone', () => {
    // Spawn is a street intersection and +Z from there is clear the whole way.
    const s = initialState();
    s.held = BIT.accel;
    for (let i = 0; i < 600; i++) step(s);
    expect(s.x).toBe(0);
    expect(s.z).toBeGreaterThan(100);
  });
});

describe('replay rejects hostile timelines', () => {
  const bad: [string, InputEvent[], number][] = [
    ['out of order', [{ tick: 9, action: 'accel', down: true }, { tick: 2, action: 'left', down: true }], 100],
    ['past the finish', [{ tick: 500, action: 'accel', down: true }], 100],
    ['negative tick', [{ tick: -1, action: 'accel', down: true }], 100],
    ['fractional tick', [{ tick: 1.5, action: 'accel', down: true }], 100],
    ['unknown action', [{ tick: 1, action: 'nitro' as never, down: true }], 100],
  ];
  for (const [name, events, finish] of bad) {
    it(name, () => expect(() => replay(events, finish)).toThrow());
  }
  it('absurd finish tick', () => expect(() => replay([], 999999)).toThrow());
});

describe('mathd', () => {
  it('matches the engine to 1e-5 across the range', () => {
    for (let i = -2000; i <= 2000; i++) {
      const a = i * 0.01;
      expect(sin(a)).toBeCloseTo(Math.sin(a), 5);
      expect(cos(a)).toBeCloseTo(Math.cos(a), 5);
    }
  });

  it('wraps angles into [-PI, PI]', () => {
    for (const a of [-100, -7, -3, 0, 3, 7, 100]) {
      expect(Math.abs(wrapAngle(a))).toBeLessThanOrEqual(Math.PI + 1e-9);
      expect(sin(a)).toBeCloseTo(Math.sin(a), 5);
    }
  });
});

describe('rng', () => {
  it('is a pure function of its seed', () => {
    const a = makeRng(seedFrom('2026-08-14'));
    const b = makeRng(seedFrom('2026-08-14'));
    for (let i = 0; i < 100; i++) expect(a()).toBe(b());
  });

  it('stays in [0, 1) and differs by seed', () => {
    const r = makeRng(seedFrom('2026-08-15'));
    for (let i = 0; i < 1000; i++) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
    expect(seedFrom('2026-08-14')).not.toBe(seedFrom('2026-08-15'));
  });
});

// ponytail: a test instead of an eslint plugin. Same guarantee, no config, no
// dependency, and it fails in the same command everything else fails in.
it('sim/ uses no engine-dependent Math', () => {
  const allowed = new Set(['abs', 'min', 'max', 'floor', 'imul', 'sqrt']);
  const dir = fileURLToPath(new URL('.', import.meta.url));
  const offenders: string[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))) {
    // ponytail: regex comment-strip, not a parser. A `//` inside a string
    // literal would blind it; sim/ has no such string and never will.
    const src = readFileSync(dir + file, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '');
    for (const m of src.matchAll(/Math\.(\w+)/g)) {
      if (!allowed.has(m[1])) offenders.push(`${file}: Math.${m[1]}`);
    }
  }
  expect(offenders).toEqual([]);
});
