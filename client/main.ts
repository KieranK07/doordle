// Phase 1: drive feel. One hardcoded map, one car, no orders.
//
// Everything here is render-side and disposable. The sim is the contract: this
// file may only feed it abstract intents and read its state. It must never
// write to sim state directly, and the sim must never learn this file exists.

import * as THREE from 'three';
import { BIT, DT, hashState, initialState, replay, step, type InputEvent, type Intent, type State } from '../sim/index.js';
import { BLOCK, CITY, RING, blockCentre } from '../sim/city.js';
import { CANON_FINISH, CANON_HASH, CANON_TIMELINE } from '../sim/fixture.js';

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

  renderer.render(scene, camera);
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
