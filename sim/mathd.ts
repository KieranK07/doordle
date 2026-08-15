// Deterministic trig. The sim may not call Math.sin/cos/tan/atan2/pow: those are
// implementation-defined and V8, SpiderMonkey and JSC genuinely disagree in the
// low bits, which is enough to desync a replay. Only +,-,*,/ and sqrt are
// bit-identical across engines by spec, so everything here is built from those.

export const PI = 3.141592653589793;
export const TAU = 6.283185307179586;
const HALF_PI = 1.5707963267948966;

/** Wrap to [-PI, PI]. */
export function wrapAngle(a: number): number {
  return a - TAU * Math.floor((a + PI) / TAU);
}

// ponytail: 9th-order Taylor on [-PI/2, PI/2] after symmetry reduction. Peak
// error ~1.4e-6 rad, far below anything a car at 60Hz can express. Upgrade to a
// minimax polynomial only if a determinism failure ever traces back to precision
// here, which it will not.
export function sin(a: number): number {
  let x = wrapAngle(a);
  if (x > HALF_PI) x = PI - x;
  else if (x < -HALF_PI) x = -PI - x;
  const x2 = x * x;
  const x3 = x2 * x;
  const x5 = x3 * x2;
  const x7 = x5 * x2;
  const x9 = x7 * x2;
  return x - x3 / 6 + x5 / 120 - x7 / 5040 + x9 / 362880;
}

export function cos(a: number): number {
  return sin(a + HALF_PI);
}

// ponytail: no atan2 yet, nothing calls it. Add it here when something does.
