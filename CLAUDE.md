# Doordle

Daily browser racing/delivery game. `SPEC.md` is the source of truth for design — read it before changing behaviour, and update it when a design decision changes.

All seven phases in SPEC.md §13 are done and deployed. New work is tuning and
polish, not phases. See SPEC.md §13 for the list. Don't build ahead of the current phase.

Pause is a client concern only. The sim never learns about it: the loop stops
calling `step()`, so no ticks pass and the recorded timeline cannot tell a
paused run from an uninterrupted one.

## Non-negotiables

- **Determinism.** Sim runs at a fixed 60 Hz, seeded RNG only, time counted in integer ticks. Under `sim/`: no `Math.random()`, no `Date.now()`, no wall-clock, no floats derived from render deltas, and no `Math.*` except `abs`/`min`/`max`/`floor`/`round`/`sqrt`/`imul` — trig comes from `sim/mathd.ts` because engines disagree on the transcendentals. Same input timeline in → bit-identical output, every time. A test enforces the allowlist; widen it only for ops the spec defines exactly.
- **One sim implementation.** The same module runs in the browser and in Node on the server. No client-side copy that drifts.
- **Client never reports a score.** It submits an input timeline; the server replays it and computes the finish tick.
- **Sim knows nothing about rendering, input devices, or cosmetics.** Sim takes abstract intents (steer left/right, accelerate, brake). Key codes stay in the input adapter; skins/trails/customisation live in the renderer where the sim structurally cannot read them.
- **Sim is 2D, renderer is 3D.** State is `{ x, z, heading, vx, vz }` on a flat plane. No vertical axis, no 3D physics engine. Three.js and the fixed-angle camera live entirely on the render side.
- **No DoorDash.** "Doordle" is fictional. No DoorDash names, branding, colours, or implied affiliation in code, UI, comments, or copy.

## Layout

```
sim/index.ts    state, step(), replay(), hashState(), collision — no DOM, no I/O
sim/city.ts     buildings and street geometry; the car collides with these
sim/district.ts district list, growth order, per-district HQ, daily rotation
sim/growth.ts   outer-player completion times and the 5-minute growth trigger
sim/puzzle.ts   the generator: HQ, home, restaurants, houses, orders, flavor
sim/daily.ts    puzzleFor(date), the validator, and the 30-day queue check
sim/traffic.ts  deterministic traffic; never reads the player, only the tick
sim/solver.ts   par: optimal route time, used for scoring and by the validator
sim/mathd.ts    engine-exact trig
sim/rng.ts      seeded RNG, daily seed derivation
sim/fixture.ts  the canned run and its pinned hash, shared with the browser check
sim/sim.test.ts every test, including the Math.* allowlist check
client/main.ts  Three.js renderer, chase cam, input adapter, HUD, minimap, results
server/worker.ts routes, sessions, Google OAuth, house claims
server/score.ts  server-side replay: the only thing that decides a time
server/board.ts  leaderboards, percentile, streaks, past winners, puzzle numbering
```

Players are public as **House #N**, never by email. The house slot is already
permanent and already on the map, so it is the handle. Do not put an email or a
Google name on a board.

Everything else gets added as its phase arrives.

## Changing physics constants

Any change to the handling constants, collision, or the puzzle changes
`CANON_HASH` in `sim/fixture.ts`. Repin it from the failing test. Free today;
once runs are stored it invalidates every recorded time, so from Phase 4 on,
treat a hash change as a migration rather than a tweak.

## Growing the city

`GROWTH_LOG` in `sim/city.ts` is the dial: one appended row, one deploy. Never
edit or remove an existing row and never date a new one inside the validated
queue — the rotation is `day % districts.length`, so changing the modulus for a
past date re-rolls a puzzle somebody already played.

Three things must stay append-only, and `sim/growth.test.ts` asserts each:
block order (collision walks the building list in sequence and each ejection
moves the car, so order is physics), building geometry (each block is seeded
from its own coordinates, never one stream walking the grid), and the
house-slot pool (a stored claim is an index into it).

`npm run growth` decides whether to grow, from the solver rather than from pool
occupancy. It reports; the append is a reviewed change.

Collision reads a bucket grid (`buildingsNear`), not the whole city. The bucket
is a superset of a full scan in CITY order, so it is a speed-up and not a
physics change — keep it that way, and `SLACK` above `CAR_RADIUS`.

## The daily puzzle

`puzzleFor(date)` is a pure function of the date: nothing is stored, nothing is
generated same-day, and the "queue" is a horizon that has been validated rather
than a table of rows. It redraws until the day passes `validate()`, so a
trivial or unplayable draw never ships. `npm run queue` prints and checks the
next 30 days and exits non-zero on a bad one; run it before a release.

The city may only grow at the edges (SPEC.md §3). `CITY_RINGS` in `sim/city.ts`
is the one dial, and raising it must leave every existing coordinate exactly
where it was — a player who learned a shortcut in month one still has it in
month six. `sim/daily.test.ts` asserts that districts append and never move.

`flavor` is cosmetic and nothing downstream may read it. It is the slot the
optional LLM pass overwrites; the deterministic strings are its fallback.

## Testing

`npm test` typechecks and runs vitest. The determinism test is the one that must never go red: 1000 replays of a fixed input timeline, identical state hash. Run it before anything touching `sim/` is considered done.
