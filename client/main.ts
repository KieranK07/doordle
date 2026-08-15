// Phase 1: drive feel. One hardcoded map, one car, no orders.
//
// Everything here is render-side and disposable. The sim is the contract: this
// file may only feed it abstract intents and read its state. It must never
// write to sim state directly, and the sim must never learn this file exists.

import * as THREE from 'three';
import { BIT, DT, TICK_HZ, carrying, hashState, initialState, replay, step, type InputEvent, type Intent, type State } from '../sim/index.js';
import { BLOCK, CITY, RING, blockCentre } from '../sim/city.js';
import { CANON_FINISH, CANON_HASH, CANON_PUZZLE, CANON_TIMELINE } from '../sim/fixture.js';
import { CARRY_LIMIT, PIN_RADIUS, localDate, puzzleFor } from '../sim/puzzle.js';
import { TRAFFIC_COUNT } from '../sim/traffic.js';
import { solve } from '../sim/solver.js';

// Today's route, by the player's own calendar: the puzzle unlocks at local
// midnight (§9). The server derives the same one from the date submitted.
const DATE = localDate();
const PUZZLE = puzzleFor(DATE);

// Perfect play for today's route. Computed once at load, ~16ms.
const PAR = solve(PUZZLE);

// ---------------------------------------------------------------- input layer

// The one place key codes are allowed to exist. Everything downstream is intent.
const BINDINGS: Record<string, Intent> = {
  KeyW: 'accel', ArrowUp: 'accel',
  KeyS: 'brake', ArrowDown: 'brake',
  KeyA: 'left', ArrowLeft: 'left',
  KeyD: 'right', ArrowRight: 'right',
};

const pending: { action: Intent; down: boolean }[] = [];
const timeline: InputEvent[] = [];
const down = new Set<Intent>();
let paused = false;

addEventListener('keydown', (e) => {
  if (e.code === 'KeyH') return runCheck();
  // Closing the results is not the same as never wanting to see them again.
  if (e.code === 'KeyB' && sim.finishTick >= 0) return showBoard();
  if (e.code === 'KeyP' || e.code === 'Escape') {
    e.preventDefault();
    return setPaused(!paused);
  }
  if (paused) return; // pausing blocks everything except unpausing
  const action = BINDINGS[e.code];
  if (!action || e.repeat || down.has(action)) return;
  down.add(action);
  pending.push({ action, down: true });
  e.preventDefault();
});

addEventListener('keyup', (e) => {
  if (paused) return;
  const action = BINDINGS[e.code];
  if (!action || !down.has(action)) return;
  down.delete(action);
  pending.push({ action, down: false });
  e.preventDefault();
});

/** Apply queued intent edges to the sim and record them at the current tick. */
function drainPending(): void {
  for (const p of pending) {
    timeline.push({ tick: sim.tick, action: p.action, down: p.down });
    if (p.down) sim.held |= BIT[p.action];
    else sim.held &= ~BIT[p.action];
  }
  pending.length = 0;
}

function setPaused(next: boolean): void {
  if (next === paused) return;
  paused = next;
  if (paused) {
    // Release everything held. Without this a player who pauses mid-throttle
    // and lets go of the key resumes with the throttle still down, because the
    // keyup was swallowed.
    for (const action of down) pending.push({ action, down: false });
    down.clear();
    drainPending();
  }
  pauseEl.style.display = paused ? 'flex' : 'none';
}

// ----------------------------------------------------------------- the world

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x8fb8d8);
scene.fog = new THREE.Fog(0x8fb8d8, 140, 260);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);

const camera = new THREE.PerspectiveCamera(42, innerWidth / innerHeight, 1, 400);
// Chase cam: locked angle relative to the CAR, so the world rotates under it.
// See SPEC.md §16.
const CAM_DIST = 46;
const CAM_HEIGHT = 62;
// Yaw follows the car with a lag instead of snapping. At 178deg/s of steering
// authority a rigid chase cam whips the whole city across the screen; the lag
// is what keeps it readable. Higher = tighter, lower = floatier.
const CAM_LAG = 5;
let camYaw = 0;

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

scene.add(new THREE.HemisphereLight(0xdceaff, 0x4a4f57, 2.1));
const sun = new THREE.DirectionalLight(0xfff4e2, 1.5);
sun.position.set(-40, 90, 40);
scene.add(sun);

const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(1400, 1400),
  new THREE.MeshLambertMaterial({ color: 0x3c4048 }),
);
ground.rotation.x = -Math.PI / 2;
scene.add(ground);

// Drawn from the same building list the sim collides against, so what you see
// is exactly what you hit.
const box = new THREE.BoxGeometry(1, 1, 1);
const palette = [0xb9c3cf, 0xa4b0be, 0xcfd6dd, 0x93a1ae, 0xdfe4e9].map(
  (color) => new THREE.MeshLambertMaterial({ color }),
);
const lawn = new THREE.MeshLambertMaterial({ color: 0x51606a });

const city = new THREE.Group();
for (let gx = -RING; gx <= RING; gx++) {
  for (let gz = -RING; gz <= RING; gz++) {
    const pad = new THREE.Mesh(box, lawn);
    pad.scale.set(BLOCK, 0.4, BLOCK);
    pad.position.set(blockCentre(gx), 0.2, blockCentre(gz));
    city.add(pad);
  }
}
let paint = 0;
for (const b of CITY) {
  const mesh = new THREE.Mesh(box, palette[paint++ % palette.length]);
  mesh.scale.set(b.hw * 2, b.h, b.hd * 2);
  mesh.position.set(b.x, b.h / 2, b.z);
  city.add(mesh);
}
scene.add(city);

// ------------------------------------------------------------------- the pins

// Colour carries all the meaning: orange = go get it, blue = take it here,
// green = your house. A pin you no longer need disappears.
const postGeo = new THREE.CylinderGeometry(1.1, 0.45, 9, 12);
// The ground ring is drawn at the real PIN_RADIUS, so the marker never lies
// about how close you actually have to get.
const ringGeo = new THREE.CircleGeometry(PIN_RADIUS, 22);
const COLORS = { restaurant: 0xf59f2b, house: 0x3d7ff2, home: 0x2fd07a, hq: 0x8a94a6 };

type Pin3D = { group: THREE.Group; ring: THREE.Mesh; post: THREE.Mesh | null };

function pinMesh(pin: { x: number; z: number }, color: number, withPost = true): Pin3D {
  const group = new THREE.Group();
  const ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.35 }));
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.08;
  group.add(ring);

  let post: THREE.Mesh | null = null;
  if (withPost) {
    post = new THREE.Mesh(postGeo, new THREE.MeshLambertMaterial({ color, transparent: true, opacity: 1 }));
    post.position.y = 4.5;
    group.add(post);
  }
  group.position.set(pin.x, 0, pin.z);
  scene.add(group);
  return { group, ring, post };
}

/**
 * A pin you are not acting on yet still has to be visible, because SPEC.md §2
 * hands the player the whole order list up front and expects them to plan with
 * it. Dimming carries "not yet" without hiding the information.
 */
function setPinState(p: Pin3D, visible: boolean, active: boolean): void {
  p.group.visible = visible;
  const dim = active ? 1 : 0.32;
  (p.ring.material as THREE.MeshBasicMaterial).opacity = active ? 0.35 : 0.14;
  if (p.post) {
    (p.post.material as THREE.MeshLambertMaterial).opacity = dim;
    p.post.scale.setScalar(active ? 1 : 0.7);
  }
}

const restaurantPins = PUZZLE.restaurants.map((p) => pinMesh(p, COLORS.restaurant));

// A restaurant can owe you more than one order, and driving through collects
// all of them at once. That is only a route decision if you can see it coming,
// so each waiting order gets a package bobbing over the pin.
const PKG_Y = 11.5;
const pkgGeo = new THREE.BoxGeometry(1.6, 1.6, 1.6);
const pkgMat = new THREE.MeshLambertMaterial({ color: 0xd8a35f });
const packages = PUZZLE.restaurants.map((_, r) => {
  const owed = PUZZLE.orders.filter((o) => o.restaurant === r).length;
  return Array.from({ length: owed }, () => {
    const m = new THREE.Mesh(pkgGeo, pkgMat);
    m.rotation.y = 0.5;
    restaurantPins[r].group.add(m);
    return m;
  });
});
const housePins = PUZZLE.houses.map((p) => pinMesh(p, COLORS.house));
const homePin = pinMesh(PUZZLE.home, COLORS.home);
/** How many orders each restaurant still owes, shared with the minimap. */
const restaurantOwed = PUZZLE.restaurants.map(() => 0);
// HQ is departure-only, so it gets a floor marker and nothing to drive into.
pinMesh(PUZZLE.hq, COLORS.hq, false);

// ------------------------------------------------------------------- the car

const car = new THREE.Group();
const body = new THREE.Mesh(box, new THREE.MeshLambertMaterial({ color: 0xe8442f }));
body.scale.set(2.1, 0.85, 4.2);
body.position.y = 0.75;
car.add(body);

const cabin = new THREE.Mesh(box, new THREE.MeshLambertMaterial({ color: 0x2c3440 }));
cabin.scale.set(1.75, 0.7, 1.9);
cabin.position.set(0, 1.5, -0.25);
car.add(cabin);

// ponytail: a flat disc, not a shadow map. Grounds the car for pennies; swap to
// a real shadow only if the lighting ever needs to sell depth on its own.
const blob = new THREE.Mesh(
  new THREE.CircleGeometry(2.2, 20),
  new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.22 }),
);
blob.rotation.x = -Math.PI / 2;
blob.position.y = 0.06;
car.add(blob);
scene.add(car);

// --------------------------------------------------------------- the traffic

const trafficMat = new THREE.MeshLambertMaterial({ color: 0x4d6b8a });
const trafficMeshes = Array.from({ length: TRAFFIC_COUNT }, () => {
  const m = new THREE.Mesh(box, trafficMat);
  m.scale.set(2, 1.5, 4);
  m.position.y = 0.9;
  scene.add(m);
  return m;
});

// ------------------------------------------------------------------ the loop

let sim = initialState(PUZZLE);
let prev: State = { ...sim };
let accumulator = 0;
let lastFrame = performance.now();

const speedEl = document.getElementById('speed') as HTMLElement;
const checkEl = document.getElementById('check') as HTMLElement;
const timerEl = document.getElementById('timer') as HTMLElement;
const stateEl = document.getElementById('state') as HTMLElement;
const pauseEl = document.getElementById('pause') as HTMLElement;

function frame(now: number): void {
  requestAnimationFrame(frame);

  // Clamped so a background tab does not come back and simulate a lost minute.
  const frameDt = Math.min(0.25, (now - lastFrame) / 1000);
  accumulator += frameDt;
  lastFrame = now;

  // Paused freezes the clock and the simulation both: the accumulator is
  // dropped rather than banked, so no time is owed on resume.
  if (paused) {
    accumulator = 0;
    renderer.render(scene, camera);
    return;
  }

  while (accumulator >= DT) {
    prev = { ...sim };
    // Edges land on the tick that consumes them, and are recorded with that
    // same tick, so the timeline replays to exactly what was played.
    drainPending();
    step(sim, PUZZLE);
    accumulator -= DT;
  }

  // Render between ticks, or a 144Hz display judders against a 60Hz sim and
  // the handling feels worse than it is.
  const a = accumulator / DT;
  const x = prev.x + (sim.x - prev.x) * a;
  const z = prev.z + (sim.z - prev.z) * a;
  const heading = prev.heading + (sim.heading - prev.heading) * a;
  car.position.set(x, 0, z);
  car.rotation.y = heading;

  // Heading is unbounded and continuous in the sim, never wrapped, so chasing
  // it needs no shortest-arc handling. Exponential decay keeps the lag the same
  // at any framerate.
  camYaw += (heading - camYaw) * (1 - Math.exp(-CAM_LAG * frameDt));
  camera.position.set(
    x - Math.sin(camYaw) * CAM_DIST,
    CAM_HEIGHT,
    z - Math.cos(camYaw) * CAM_DIST,
  );
  camera.lookAt(x, 0, z);

  for (let i = 0; i < trafficMeshes.length; i++) {
    const c = sim.traffic.cars[i];
    trafficMeshes[i].position.x = c.x;
    trafficMeshes[i].position.z = c.z;
    trafficMeshes[i].rotation.y = c.dir * (Math.PI / 2);
  }

  const speed = Math.hypot(sim.vx, sim.vz) * 3.6;
  speedEl.firstChild!.textContent = String(Math.round(speed));
  drawStatus();
  drawMap();

  renderer.render(scene, camera);
}

// The client never sends a time. It sends what was pressed and when, and the
// server replays it to decide the time (SPEC.md §10).
let submitted = false;
function submitRun(): void {
  if (submitted || sim.finishTick < 0) return;
  submitted = true;
  fetch('/api/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ date: DATE, inputEvents: timeline, claimedFinishTick: sim.finishTick }),
  })
    .then(async (res) => ({ status: res.status, body: await res.json() as { error?: string } }))
    .then(({ status, body }) => {
      checkEl.textContent = status === 200 ? 'run recorded' : `not recorded: ${body.error ?? status}`;
      checkEl.style.color = status === 200 ? '#6ee7a8' : '#e0a458';
      // 409 means today's run is already stored, from this browser or another
      // one. The board is unlocked either way, so it still opens.
      if (status === 200 || status === 409) showBoard();
    })
    .catch(() => {
      checkEl.textContent = 'not recorded: no server';
      checkEl.style.color = '#e0a458';
    });
}

// ------------------------------------------------------------- the results

type Board = {
  number: number;
  you: { slot: number; rank: number; total: number; percentile: number; finishTick: number; streak: number };
  daily: { rank: number; slot: number; finishTick: number }[];
  monthly: { rank: number; slot: number; avgTick: number; days: number }[];
  winners: { date: string; number: number; slot: number; finishTick: number }[];
};

const boardEl = document.getElementById('board') as HTMLElement;
const boardBody = document.getElementById('board-body') as HTMLElement;
let shareText = '';

const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);

function rows<T extends { rank: number; slot: number }>(
  list: T[],
  mine: number,
  right: (r: T) => string,
): string {
  if (!list.length) return '<div class="empty">nobody yet</div>';
  return `<table>${list
    .map(
      (r) =>
        `<tr class="${r.slot === mine ? 'me' : ''}"><td>${r.rank}</td>` +
        `<td>House #${r.slot}</td><td>${esc(right(r))}</td></tr>`,
    )
    .join('')}</table>`;
}

function render(b: Board): void {
  const delta = (b.you.finishTick - PAR.ticks) / TICK_HZ;
  const off = delta <= 0 ? `${(-delta).toFixed(0)}s under par` : `${delta.toFixed(0)}s off par`;

  // Spoiler-free by construction (SPEC.md §11): a time, a par gap, a
  // percentile. Nothing here hints at the route.
  shareText =
    `Doordle #${b.number}\n${clock(b.you.finishTick)} - ${off}\nTop ${b.you.percentile}%` +
    (b.you.streak > 1 ? `\n${b.you.streak} day streak` : '');

  boardBody.innerHTML =
    `<h1>Doordle #${b.number}</h1>` +
    `<div>${clock(b.you.finishTick)} &middot; ${esc(off)} &middot; ` +
    `rank ${b.you.rank} of ${b.you.total} (top ${b.you.percentile}%) &middot; ` +
    `${b.you.streak} day streak</div>` +
    `<div id="share">${esc(shareText)}</div>` +
    `<button id="copy">Copy result</button><button id="close">Close</button>` +
    `<h2>Today</h2>${rows(b.daily, b.you.slot, (r) => clock(r.finishTick))}` +
    `<h2>Last 30 days (average)</h2>` +
    rows(b.monthly, b.you.slot, (r) => `${clock(r.avgTick)} · ${r.days}d`) +
    `<h2>Past winners</h2>` +
    (b.winners.length
      ? `<table>${b.winners
          .map(
            (w) =>
              `<tr class="${w.slot === b.you.slot ? 'me' : ''}"><td>#${w.number}</td>` +
              `<td>House #${w.slot}</td><td>${clock(w.finishTick)}</td></tr>`,
          )
          .join('')}</table>`
      : '<div class="empty">no day has closed yet</div>');

  boardEl.style.display = 'flex';
  document.getElementById('close')!.onclick = () => (boardEl.style.display = 'none');
  document.getElementById('copy')!.onclick = (e) => {
    navigator.clipboard.writeText(shareText);
    (e.currentTarget as HTMLElement).textContent = 'Copied';
  };
}

function showBoard(): void {
  fetch(`/api/board?date=${DATE}`)
    .then(async (res) => (res.ok ? ((await res.json()) as Board) : null))
    .then((b) => b && render(b))
    .catch(() => undefined);
}

function clock(ticks: number): string {
  const total = ticks / TICK_HZ;
  const m = Math.floor(total / 60);
  const s = total - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, '0')}`;
}

function drawStatus(): void {
  const all = PUZZLE.orders.length;
  const done = countSetBits(sim.delivered);

  // A restaurant stays visible while it owes you anything, and goes bright once
  // there is room aboard to actually collect from it.
  const load = carrying(sim);
  const room = load < CARRY_LIMIT;
  const bob = performance.now() / 1000;
  for (let i = 0; i < restaurantPins.length; i++) {
    const owed = PUZZLE.orders.filter((o, k) => o.restaurant === i && !(sim.picked & (1 << k))).length;
    setPinState(restaurantPins[i], owed > 0, owed > 0 && room);
    restaurantOwed[i] = owed;

    for (let k = 0; k < packages[i].length; k++) {
      const box = packages[i][k];
      box.visible = k < owed;
      if (!box.visible) continue;
      // Boxes beyond what will fit in the car sit lower and still, so a full
      // car reads as "you cannot take all of these" at a glance.
      const fits = k < CARRY_LIMIT - load;
      box.position.x = (k - (owed - 1) / 2) * 2.2;
      box.position.y = PKG_Y + (fits ? Math.sin(bob * 3.2 + k * 0.8) * 0.7 : -1.4);
      box.rotation.y = fits ? 0.5 + Math.sin(bob * 1.4 + k) * 0.25 : 0.5;
    }
  }
  // Every undelivered house shows. Bright once its order is aboard, dim before
  // that, because knowing where it is up front is the whole planning problem.
  for (let i = 0; i < housePins.length; i++) {
    const bit = 1 << i;
    setPinState(housePins[i], !(sim.delivered & bit), Boolean(sim.picked & bit));
  }
  // Your own house is visible from the start of the run, per SPEC.md §8.
  setPinState(homePin, true, done === all);

  timerEl.textContent = clock(sim.finishTick >= 0 ? sim.finishTick : sim.tick);
  if (sim.finishTick >= 0) {
    submitRun();
    const delta = (sim.finishTick - PAR.ticks) / TICK_HZ;
    const off = delta <= 0 ? `${(-delta).toFixed(1)}s UNDER par` : `${delta.toFixed(1)}s off par`;
    stateEl.textContent = `finished · ${off}`;
    stateEl.style.color = delta <= 0 ? '#6ee7a8' : '#e7ecf3';
  } else {
    stateEl.textContent =
      `delivered ${done}/${all} · carrying ${carrying(sim)}/${CARRY_LIMIT} · par ${clock(PAR.ticks)}`;
    stateEl.style.color = '';
  }
}

function countSetBits(mask: number): number {
  let n = 0;
  for (let m = mask; m; m >>= 1) n += m & 1;
  return n;
}

// -------------------------------------------------------------- the minimap

// SPEC.md §2 gives the player the whole order list up front, which is only true
// if they can see where the pins are. The chase camera shows maybe a block and
// a half, so without this the game is guesswork.
const mapCanvas = document.getElementById('map') as HTMLCanvasElement;
const mapCtx = mapCanvas.getContext('2d')!;
const MAP_PX = mapCanvas.width;
const MAP_MID = MAP_PX / 2;

/** World half-extent visible on the map, and the world-to-pixel scale. */
const MAP_RANGE = 300;
const MAP_K = MAP_MID / MAP_RANGE;

// Buildings never move, so they get drawn once into a world-aligned image and
// blitted under the rotation after that.
const BACKDROP_WORLD = 900;
const backdrop = document.createElement('canvas');
backdrop.width = backdrop.height = 900;
{
  const b = backdrop.getContext('2d')!;
  const toBackdrop = (v: number) => ((v + BACKDROP_WORLD / 2) / BACKDROP_WORLD) * backdrop.width;
  const k = backdrop.width / BACKDROP_WORLD;
  b.fillStyle = '#79879a';
  for (const bd of CITY) {
    b.fillRect(toBackdrop(bd.x) - bd.hw * k, toBackdrop(bd.z) - bd.hd * k, bd.hw * 2 * k, bd.hd * 2 * k);
  }
}

/**
 * The map turns with the car, so up on the map is the direction you are
 * pointed, matching the chase camera. Forward is (sin h, cos h) and +Z is down
 * in map space, so rotating by (heading - PI) puts forward at the top.
 */
function mapAngle(): number {
  return sim.heading - Math.PI;
}

/** World point to map pixel, honouring the rotation. */
function toScreen(wx: number, wz: number): { x: number; y: number } {
  const a = mapAngle();
  const c = Math.cos(a);
  const s = Math.sin(a);
  const dx = wx - sim.x;
  const dz = wz - sim.z;
  return { x: (dx * c - dz * s) * MAP_K + MAP_MID, y: (dx * s + dz * c) * MAP_K + MAP_MID };
}

function dot(wx: number, wz: number, color: string, r: number): { x: number; y: number } {
  const p = toScreen(wx, wz);
  // A pin past the edge gets pinned to it rather than vanishing, so the map
  // never silently drops information the player is meant to be planning with.
  const m = r + 3;
  const x = Math.min(MAP_PX - m, Math.max(m, p.x));
  const y = Math.min(MAP_PX - m, Math.max(m, p.y));
  const clamped = x !== p.x || y !== p.y;
  mapCtx.fillStyle = color;
  mapCtx.globalAlpha = clamped ? 0.65 : 1;
  mapCtx.beginPath();
  mapCtx.arc(x, y, clamped ? r * 0.72 : r, 0, Math.PI * 2);
  mapCtx.fill();
  mapCtx.globalAlpha = 1;
  return { x, y };
}

function drawMap(): void {
  mapCtx.clearRect(0, 0, MAP_PX, MAP_PX);

  mapCtx.save();
  mapCtx.translate(MAP_MID, MAP_MID);
  mapCtx.rotate(mapAngle());
  mapCtx.scale(MAP_K, MAP_K);
  mapCtx.translate(-sim.x, -sim.z);
  mapCtx.globalAlpha = 0.5;
  mapCtx.drawImage(backdrop, -BACKDROP_WORLD / 2, -BACKDROP_WORLD / 2, BACKDROP_WORLD, BACKDROP_WORLD);
  mapCtx.globalAlpha = 1;
  mapCtx.restore();

  for (let i = 0; i < PUZZLE.restaurants.length; i++) {
    if (!restaurantOwed[i]) continue;
    const p = PUZZLE.restaurants[i];
    const s = dot(p.x, p.z, '#f59f2b', restaurantOwed[i] > 1 ? 12 : 9);
    if (restaurantOwed[i] > 1) {
      // The count is the whole point of the bigger dot: a stop that fills the
      // car is a different route decision from one that does not.
      mapCtx.fillStyle = '#1a1206';
      mapCtx.font = 'bold 15px ui-monospace, monospace';
      mapCtx.textAlign = 'center';
      mapCtx.textBaseline = 'middle';
      mapCtx.fillText(String(restaurantOwed[i]), s.x, s.y + 1);
    }
  }
  for (let i = 0; i < PUZZLE.houses.length; i++) {
    const bit = 1 << i;
    // Houses you are not carrying for yet still show, dimmer: that is the
    // planning information the whole puzzle rests on.
    if (sim.delivered & bit) continue;
    dot(PUZZLE.houses[i].x, PUZZLE.houses[i].z, sim.picked & bit ? '#3d7ff2' : 'rgba(61,127,242,0.35)', 8);
  }
  dot(PUZZLE.home.x, PUZZLE.home.z, '#2fd07a', 9);

  // The car sits at the centre and always points up, because the world is what
  // rotates now.
  mapCtx.fillStyle = '#ff5540';
  mapCtx.beginPath();
  mapCtx.moveTo(MAP_MID, MAP_MID - 11);
  mapCtx.lineTo(MAP_MID + 7, MAP_MID + 8);
  mapCtx.lineTo(MAP_MID - 7, MAP_MID + 8);
  mapCtx.closePath();
  mapCtx.fill();
}
requestAnimationFrame(frame);

// ------------------------------------------------------- determinism check

// Two claims, one keypress. First: this engine agrees with Node on the canned
// fixture, which is what server-side replay rests on. Second: the timeline
// recorded from live play replays to the live state, which is what makes an
// input timeline a valid substitute for a reported score.
//
// Run this in Firefox too. Chrome shares V8 with Node, so it cannot fail the
// first claim for the reason we actually care about.
function runCheck(): void {
  const canon = hashState(replay(CANON_TIMELINE, CANON_FINISH, CANON_PUZZLE));
  const live = hashState(sim);
  const replayed = hashState(replay(timeline, sim.tick, PUZZLE));
  const ok = canon === CANON_HASH && live === replayed;
  checkEl.textContent = ok
    ? `determinism ok · ${timeline.length} events · tick ${sim.tick}`
    : `MISMATCH canon ${canon}/${CANON_HASH} live ${live}/${replayed}`;
  checkEl.style.color = ok ? '#6ee7a8' : '#ff7a6b';
  console.log('[doordle] canon', canon, 'expected', CANON_HASH, '| live', live, 'replayed', replayed);
}
