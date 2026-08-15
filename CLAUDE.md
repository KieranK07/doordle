# Doordle

Daily browser racing/delivery game. `SPEC.md` is the source of truth for design — read it before changing behaviour, and update it when a design decision changes.

Current phase: **Phase 0 (foundations)**. See SPEC.md §13 for the phase list. Don't build ahead of the current phase.

## Non-negotiables

- **Determinism.** Sim runs at a fixed 60 Hz, seeded RNG only, time counted in integer ticks. Under `sim/`: no `Math.random()`, no `Date.now()`, no wall-clock, no floats derived from render deltas, and no `Math.*` except `abs`/`min`/`max`/`floor`/`sqrt`/`imul` — trig comes from `sim/mathd.ts` because engines disagree on the transcendentals. Same input timeline in → bit-identical output, every time. A test enforces the allowlist; widen it only for ops the spec defines exactly.
- **One sim implementation.** The same module runs in the browser and in Node on the server. No client-side copy that drifts.
- **Client never reports a score.** It submits an input timeline; the server replays it and computes the finish tick.
- **Sim knows nothing about rendering, input devices, or cosmetics.** Sim takes abstract intents (steer left/right, accelerate, brake). Key codes stay in the input adapter; skins/trails/customisation live in the renderer where the sim structurally cannot read them.
- **Sim is 2D, renderer is 3D.** State is `{ x, z, heading, vx, vz }` on a flat plane. No vertical axis, no 3D physics engine. Three.js and the fixed-angle camera live entirely on the render side.
- **No DoorDash.** "Doordle" is fictional. No DoorDash names, branding, colours, or implied affiliation in code, UI, comments, or copy.

## Layout

```
sim/index.ts    state, step(), replay(), hashState() — no DOM, no I/O
sim/mathd.ts    engine-exact trig
sim/rng.ts      seeded RNG, daily seed derivation
sim/sim.test.ts the determinism test and the Math.* allowlist check
```

Everything else gets added as its phase arrives.

## Testing

`npm test` typechecks and runs vitest. The determinism test is the one that must never go red: 1000 replays of a fixed input timeline, identical state hash. Run it before anything touching `sim/` is considered done.
