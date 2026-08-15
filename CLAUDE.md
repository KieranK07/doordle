# Doordle

Daily browser racing/delivery game. `SPEC.md` is the source of truth for design — read it before changing behaviour, and update it when a design decision changes.

Current phase: **Phase 3 (traffic and pause)**. Phases 0 to 2 are done. See SPEC.md §13 for the list. Don't build ahead of the current phase.

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
sim/city.ts     buildings; the car collides with these, so they live in the sim
sim/puzzle.ts   HQ, home, restaurants, houses, orders, pin radius, carry limit
sim/solver.ts   par: optimal route time, used for scoring and by the validator
sim/mathd.ts    engine-exact trig
sim/rng.ts      seeded RNG, daily seed derivation
sim/fixture.ts  the canned run and its pinned hash, shared with the browser check
sim/sim.test.ts every test, including the Math.* allowlist check
client/main.ts  Three.js renderer, chase cam, input adapter, HUD, minimap
```

Everything else gets added as its phase arrives.

## Changing physics constants

Any change to the handling constants, collision, or the puzzle changes
`CANON_HASH` in `sim/fixture.ts`. Repin it from the failing test. Free today;
once runs are stored it invalidates every recorded time, so from Phase 4 on,
treat a hash change as a migration rather than a tweak.

## Testing

`npm test` typechecks and runs vitest. The determinism test is the one that must never go red: 1000 replays of a fixed input timeline, identical state hash. Run it before anything touching `sim/` is considered done.
