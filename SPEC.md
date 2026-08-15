# Doordle: Project Spec

A daily browser game. One run per day, everyone races the same delivery route, fastest time wins.

This document is the source of truth for the design. Build in the phase order at the bottom. Do not skip Phase 0, the determinism decisions there are painful to retrofit.

---

## 1. Concept

You are a little car driving at absurd speeds for a delivery company called **Doordle**. Each day you start at Doordle HQ, pick up food from restaurants scattered around the city, drop it at customer houses, and finish at your own house. Your time is the score.

Note: "Doordle" is the in-game fictional company. Do not reference DoorDash, use their branding, or imply any affiliation anywhere in the codebase, UI, or marketing copy.

Target run length: under 5 minutes. Should feel snappy and arcade-y, not simulation-y.

---

## 2. Core loop

1. Player loads the site. Sees today's puzzle number and a Start button.
2. On start, the full order list is revealed and the timer begins immediately.
3. Player drives from HQ, batching restaurant pickups and house dropoffs, subject to a 3-order carry limit.
4. After the last dropoff, player drives to their own house. Timer stops on arrival.
5. Run is submitted, scored server-side, leaderboard unlocks.
6. Player gets a spoiler-free share card. Cannot play again until local midnight.

**Full information at start.** The entire order list is visible from the moment the timer begins. This is a planning-and-execution game, not a reactive one. No orders drip in mid-run.

---

## 3. The city

**One fixed city, persistent forever.** The map does not regenerate daily. Only orders and traffic change day to day. Players are expected to learn the map over weeks and get faster through route knowledge. This accumulated skill is the retention mechanic.

**The city grows with the player base.** As more accounts register, the city expands to accommodate new houses.

Critical constraint on growth: **expand at the edges only.** Never alter existing roads, restaurant positions, or assigned house locations. A player who learned a shortcut in month one must still have that shortcut in month six. Model the city as a set of districts; append new districts at the perimeter with their own roads and restaurants, connected to the existing network at defined junction points.

**Every district has its own HQ.** Each day's route is set within one district and starts at that district's HQ. Districts rotate day to day.

Suggested representation: a graph of road segments with 2D coordinates, plus a district ID per node. Keep it data-driven (JSON or DB rows), not hardcoded geometry, so districts can be appended programmatically.

**Growth trigger.** Do not grow on house-pool percentage. Grow on **playability**: spawn a new district only when the calculated average completion time for the outermost players exceeds **5 minutes**. Compute this from the optimal-route solver, not from live player times, so it is predictable and not skewed by bad drivers. Make the 5-minute threshold a config value, it will need tuning.

Rationale: the constraint that actually matters is run length. A player whose house sits so far from the day's route that their run blows past 5 minutes is having a bad experience regardless of how many houses are free. Growth exists to keep runs short, not to warehouse accounts.

Every house has: id, coordinates, district, claimed_by (nullable).

**District rotation and fairness.** Rotating which district hosts the daily route is load-bearing, not cosmetic. If routes were drawn uniformly across the whole map, outer-ring houses would be permanently farther from the average route than central ones, which is a systematic disadvantage for late joiners rather than luck that rotates. Rotation gives every district its home-field days and keeps each day's map a tight, readable puzzle instead of a cross-city slog.

---

## 4. Orders, restaurants, capacity

- Restaurants are fixed map features, scattered across districts.
- Each order = (restaurant, destination house). You must visit the restaurant before the house.
- **Carry capacity: 3 orders at once.** This is the heart of the puzzle. It forces the player to decide which pickups to batch and in what order.
- **HQ is departure-only.** You never return to it. The starting point is the HQ of whichever district hosts today's route, and it is the same HQ for every player that day, regardless of where their own house is.
- Pickups and dropoffs **auto-complete when the car passes through the pin.** No button press, no required full stop. But the pin hitbox should be tight enough that precision driving matters and sloppy lines cost you.

Daily order count should be tuned so a good run lands in the 2 to 4 minute range. Start around 6 to 8 orders and tune from playtesting.

---

## 5. Scoring and fairness

**Score = total elapsed time from HQ departure to arrival at your own house.** Lower is better.

The delivery route (restaurants, customer houses, order list) is **identical for every player each day.** The only difference is the final leg, which goes to each player's own assigned house.

This introduces a known, deliberate, accepted asymmetry: some days your house sits conveniently near the last dropoff, some days it does not. This is intentional. Because the house is fixed and the route changes daily, the advantage rotates over time.

**Leaderboards are worldwide only.** No friends lists, no district boards, no skill divisions. One global table.

- **Daily.** Fastest time that day. The winner goes on the permanent historical leaderboard. This is the headline and the social hook.
- **Cumulative.** Rolling 30-day average. This is where house-location luck washes out and consistent players are rewarded. Both boards are visible.

**Always show percentile alongside rank.** "Top 6%" stays meaningful at any player count; "8,431st" does not. Rank is the headline for the top of the board, percentile is what everyone else actually reads.

**Par.** Every run also shows your time against the solver's optimal route for that day, e.g. "14 seconds off par". The validator already computes this number to sanity-check difficulty, so it is nearly free.

Par is what makes the game satisfying with zero other players online, because the thing you are actually racing is the puzzle rather than the crowd. It also gives every run a clear success/failure feeling that does not depend on turnout. Frame it as a target to chase, not an opponent that beat you.

**Streaks.** Track consecutive days played and surface it prominently. This is the primary retention mechanic and it works with any player count, including one. A streak should require completing a run, not just loading the page.

---

## 6. Traffic

Traffic cars drive the roads as moving obstacles.

**Traffic must be fully deterministic and identical for every player.** Seed traffic spawn positions, routes, and speeds from the daily puzzle seed. Advance traffic on the fixed simulation tick, never on wall-clock time. Two players starting at different real-world moments must encounter byte-identical traffic at the same elapsed tick.

Collision handling: a brief speed penalty (spin-out, momentum loss) rather than a full stop. Full stops feel punitive and kill the arcade energy. Tune the penalty so that threading traffic well is meaningfully faster than plowing through it.

---

## 7. Pause

Player can pause at any time. Pausing:

- Freezes the game clock and the simulation.
- Drops a grey overlay panel over the play area reading "Paused".
- Blocks all input except unpause.

The overlay must **fully obscure the map and the play area.** If the map stays visible while paused, unlimited free planning time becomes the dominant strategy.

---

## 8. Accounts and houses

- **Google login (OAuth).** Logged-in players get a permanently assigned house from the unclaimed pool. That house is theirs indefinitely.
- **Guests** get a random unclaimed house for the session, can play the full game, but do not appear on any leaderboard. Make this clear in the UI before they start, with a prompt to sign in.
- Do not attempt to enforce one-play-per-day for guests. It is not enforceable in a browser and trying will only frustrate real users. One-per-day is enforced server-side for logged-in accounts only, which is where it matters.
- A player's own house is visible on their map from the start of the run.

---

## 9. Daily rollover and cutoff

- **Puzzle unlocks at local midnight** for each player. Everyone gets a fresh puzzle when their own day turns over.
- **Daily winner is determined at UTC midnight.** This gives a single well-defined global moment to close the day and crown a winner, since local midnight is not a single instant worldwide.
- **Leaderboard is locked until the player submits their run.** No peeking at other people's times or routes beforehand.

---

## 10. Anti-cheat and determinism

The client must never report a score. The client reports an **input timeline**, the server replays it and computes the time.

This requires deterministic simulation. Build it this way from the start:

- Fixed timestep simulation loop, decoupled from render framerate.
- Seeded RNG, one seed per day, derived from the date. No use of `Math.random()` anywhere in simulation code.
- Reproducible physics. Avoid float drift where possible; consider fixed-point or carefully constrained float ops. Verify determinism with a test that replays the same input timeline 1000 times and asserts identical output.
- Client submits: `{ date, seed, inputEvents: [{tick, action}], claimedFinishTick }`.
- Server replays the input timeline against the same simulation code and computes the authoritative finish tick. Mismatch beyond tolerance means reject the run.
- Share the simulation code between client and server (same module, run in Node server-side) so there is exactly one implementation.

**Bonus:** the stored input timeline is exactly what you need to render the Instagram overlay video showing every run at once. Same data, two uses. Design the storage format with that in mind.

---

## 11. Share card

Spoiler-free, since everyone plays the same route. Something like:

```
Doordle #47
2:14 - 14s off par
Top 6%
```

Optionally a tiny emoji strip encoding pickup/dropoff order or a small route trace image. Must not reveal the route to someone who has not played yet. Copy-to-clipboard button.

---

## 12. Daily puzzle generation

Puzzles are generated ahead of time and queued, never generated same-day. A bad generation should never be a live incident.

**Skeleton-first, flavor-second.** The puzzle logic must be produced by deterministic code, not an LLM:

1. **Deterministic generator (code).** Picks the day's restaurants, customer houses, order pairings, and traffic seed from the date seed. Solvable by construction.
2. **Validator (code).** Confirms the order set is completable under the 3-carry limit, computes the optimal-ish route time to sanity-check difficulty, and rejects anything outside the target time band.
3. **Flavor pass (optional, LLM).** Claude writes customer names, order contents, and any flavor text. Purely cosmetic. Never touches puzzle logic. If this step fails, ship the puzzle with fallback flavor.
4. Queue at least 30 days ahead so there is always a buffer to spot-check.

---

## 13. Build order

**Phase 0: Foundations.** Deterministic fixed-timestep simulation loop, seeded RNG, input-timeline recording and replay. Write the determinism test first. Nothing else gets built until replay is bit-identical.

**Phase 1: Drive feel.** One hardcoded map, one car, no orders. Desktop only, keyboard controls. Iterate on handling and speed until it is fun to just drive around with no objective at all. Do not proceed until this is genuinely fun.

**Phase 2: Core game.** City data model, restaurants, houses, orders, 3-carry limit, pickup/dropoff, timer, win condition, optimal-route solver and par display. Single-player, local, no accounts.

**Phase 3: Traffic and pause.** Deterministic traffic, collision penalties, pause overlay.

**Phase 4: Backend.** Google OAuth, house assignment, server-side replay validation, run storage, one-per-day enforcement.

**Phase 5: Leaderboards and social.** Worldwide daily board, cumulative 30-day board, percentiles, streak tracking, historical winners, share card, leaderboard lock until submit.

**Phase 6: Generation pipeline.** Deterministic daily generator, validator, district rotation schedule, 30-day queue, optional flavor pass.

**Phase 7: City growth.** District append system with per-district HQ, outer-player completion-time monitoring, 5-minute growth trigger.

---

## 14. Open questions to resolve during build

- Exact daily order count, tuned from playtesting to hit the 2 to 4 minute target.
- Collision penalty magnitude.
- Pin hitbox size (the precision-vs-frustration dial).
- City size at launch and houses per district. Launch small. A tight map with 30 houses feels intimate with 10 players; a sprawling metro with 10 players feels dead. Let the growth system do the expanding.

Tech stack is no longer open, see §16.

---

## 15. Deferred scope

Explicitly out of scope for the initial build. Listed so the architecture does not preclude them.

**Mobile.** Desktop browser with keyboard controls only for now.

Do not paint yourself into a corner on it. Keep the input layer abstracted behind an intent interface (steer left, steer right, accelerate, brake) rather than reading key codes directly in the simulation. Input events in the recorded timeline should be these abstract intents, not raw keystrokes. That way adding a touch control scheme later is a new input adapter, not a rewrite of the sim and the replay format.

**Monetization.** Nothing paid at launch. The eventual direction is cosmetic microtransactions: car skins, trails, map and house customization, generally anything visual.

Hard rule when that day comes: **never sell anything that affects run time.** Pay-to-win kills a leaderboard game the day it ships, and once players suspect it exists they do not come back. Keep cosmetics in a presentation layer that the deterministic simulation cannot read, so a paid skin is structurally incapable of changing a result.

**Also dropped, deliberately:** ghost cars, friends leaderboards, skill divisions, district-level leaderboards.

---

## 16. Locked technical decisions

Settled before Phase 0. The first three are expensive to reverse; change them only with a reason.

**Look and feel: Smashy Road.** 3D, low-poly, camera at a fixed angle above the car.

**The simulation is 2D. Only the renderer is 3D.** Sim state is `{ x, z, heading, vx, vz }` on a flat plane. No vertical axis, no suspension, no 3D physics engine, no ramps or jumps. Buildings are rectangles the car collides with, roads are the gaps between them. This keeps determinism cheap and the replay format small, and it is what Smashy Road actually is under the art.

**The car moves freely, it is not locked to the road graph.** Cutting a corner or clipping an alley is allowed and is exactly the kind of knowledge §3's retention model depends on. The road graph still exists, but only the optimal-route solver and the daily generator read it. The sim never does.

**Camera: fixed rotation, car-relative steering.** The camera follows the car's position and never rotates, so north is always up and the map looks identical every single day. Steering turns the car, not the world. A chase cam was considered and rejected: route memory is the whole retention mechanic, and it is much harder to build when the map swings around on every turn.

**Sim math: float64, with `Math.*` banned inside `sim/`.** `+ - * /` and `sqrt` are bit-identical across every JS engine by spec, so plain doubles are safe. The transcendentals are not — `sin`, `cos`, `atan2`, `pow` are implementation-defined and genuinely differ between V8 and SpiderMonkey. The sim gets its own `sin`/`cos` in `sim/mathd.ts` and a test blocking `Math.*` in `sim/` apart from `abs`, `min`, `max`, `floor`, `sqrt`, `imul`, all of which the language spec defines exactly.

**Tick rate: 60 Hz fixed.** All durations are integer tick counts. Milliseconds never enter the sim or the stored run.

**Input timeline records intent edges, not per-tick samples.** `{ tick, action, down }` on press and release only; replay reconstructs held state between edges. This is both the anti-cheat submission format and the source data for the Instagram overlay video, so it stays small and stays stable.

**Stack:** TypeScript throughout, Vite for the client, Three.js for rendering, Node for the server, vitest for tests. One package, no monorepo tooling.

**Determinism test:** FNV-1a hash over the serialized sim state, asserted identical across 1000 replays of a fixed input timeline.
