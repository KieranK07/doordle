// Phase 1: drive feel. One hardcoded map, one car, no orders.
//
// Everything here is render-side and disposable. The sim is the contract: this
// file may only feed it abstract intents and read its state. It must never
// write to sim state directly, and the sim must never learn this file exists.

import * as THREE from 'three';
import { BIT, DT, TICK_HZ, carrying, hashState, initialState, replay, step, type InputEvent, type Intent, type State } from '../sim/index.js';
import { BLOCK, CITY, RING, blockCentre } from '../sim/city.js';
import { CANON_FINISH, CANON_HASH, CANON_TIMELINE } from '../sim/fixture.js';
import { CARRY_LIMIT, PIN_RADIUS, PUZZLE } from '../sim/puzzle.js';
import { solve } from '../sim/solver.js';

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

addEventListener('keydown', (e) => {
  if (e.code === 'KeyH') return runCheck();
  const action = BINDINGS[e.code];
  if (!action || e.repeat || down.has(action)) return;
  down.add(action);
  pending.push({ action, down: true });
  e.preventDefault();
});

addEventListener('keyup', (e) => {
  const action = BINDINGS[e.code];
  if (!action || !down.has(action)) return;
  down.delete(action);
  pending.push({ action, down: false });
  e.preventDefault();
});

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

function pinMesh(pin: { x: number; z: number }, color: number, post = true): THREE.Group {
  const g = new THREE.Group();
  const ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.35 }));
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.08;
  g.add(ring);
  if (post) {
    const p = new THREE.Mesh(postGeo, new THREE.MeshLambertMaterial({ color }));
    p.position.y = 4.5;
    g.add(p);
  }
  g.position.set(pin.x, 0, pin.z);
  scene.add(g);
  return g;
}

const restaurantPins: THREE.Group[] = PUZZLE.restaurants.map((p) => pinMesh(p, COLORS.restaurant));
const housePins: THREE.Group[] = PUZZLE.houses.map((p) => pinMesh(p, COLORS.house));
const homePin = pinMesh(PUZZLE.home, COLORS.home);
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

// ------------------------------------------------------------------ the loop

let sim = initialState();
let prev: State = { ...sim };
let accumulator = 0;
let lastFrame = performance.now();

const speedEl = document.getElementById('speed') as HTMLElement;
const checkEl = document.getElementById('check') as HTMLElement;
const timerEl = document.getElementById('timer') as HTMLElement;
const stateEl = document.getElementById('state') as HTMLElement;

function frame(now: number): void {
  requestAnimationFrame(frame);

  // Clamped so a background tab does not come back and simulate a lost minute.
  const frameDt = Math.min(0.25, (now - lastFrame) / 1000);
  accumulator += frameDt;
  lastFrame = now;

  while (accumulator >= DT) {
    prev = { ...sim };
    // Edges land on the tick that consumes them, and get recorded with that
    // same tick, so the timeline replays to exactly what was played.
    for (const p of pending) {
      timeline.push({ tick: sim.tick, action: p.action, down: p.down });
      if (p.down) sim.held |= BIT[p.action];
      else sim.held &= ~BIT[p.action];
    }
    pending.length = 0;
    step(sim);
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

  const speed = Math.hypot(sim.vx, sim.vz) * 3.6;
  speedEl.firstChild!.textContent = String(Math.round(speed));
  drawStatus();
  drawMap();

  renderer.render(scene, camera);
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

  // A restaurant is worth stopping at only while it still owes you something.
  for (let i = 0; i < restaurantPins.length; i++) {
    restaurantPins[i].visible = PUZZLE.orders.some(
      (o, k) => o.restaurant === i && !(sim.picked & (1 << k)),
    );
  }
  // A house matters once its order is aboard, and stops mattering once dropped.
  for (let i = 0; i < housePins.length; i++) {
    const bit = 1 << i;
    housePins[i].visible = Boolean(sim.picked & bit) && !(sim.delivered & bit);
  }
  homePin.visible = done === all;

  timerEl.textContent = clock(sim.finishTick >= 0 ? sim.finishTick : sim.tick);
  if (sim.finishTick >= 0) {
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

function dot(wx: number, wz: number, color: string, r: number): void {
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
    if (restaurantPins[i].visible) dot(PUZZLE.restaurants[i].x, PUZZLE.restaurants[i].z, '#f59f2b', 9);
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
  const canon = hashState(replay(CANON_TIMELINE, CANON_FINISH));
  const live = hashState(sim);
  const replayed = hashState(replay(timeline, sim.tick));
  const ok = canon === CANON_HASH && live === replayed;
  checkEl.textContent = ok
    ? `determinism ok · ${timeline.length} events · tick ${sim.tick}`
    : `MISMATCH canon ${canon}/${CANON_HASH} live ${live}/${replayed}`;
  checkEl.style.color = ok ? '#6ee7a8' : '#ff7a6b';
  console.log('[doordle] canon', canon, 'expected', CANON_HASH, '| live', live, 'replayed', replayed);
}
