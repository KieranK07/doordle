// One canned run, shared by the Node test and the browser self-check. A single
// fixture in one place is what makes the claim checkable at all: if a browser
// prints this same hash, that browser's engine agrees with Node, which is the
// premise server-side replay rests on.
//
// Note that Chrome proves less than it looks like it does, since Chrome and
// Node are both V8. Firefox or Safari is the check that actually closes the
// cross-engine question, and it costs one page load plus one keypress.

import type { InputEvent } from './index.js';

export const CANON_TIMELINE: readonly InputEvent[] = [
  { tick: 0, action: 'accel', down: true },
  { tick: 37, action: 'right', down: true },
  { tick: 91, action: 'right', down: false },
  { tick: 92, action: 'left', down: true },
  { tick: 140, action: 'brake', down: true },
  { tick: 155, action: 'brake', down: false },
  { tick: 201, action: 'left', down: false },
  { tick: 333, action: 'accel', down: false },
];

export const CANON_FINISH = 900;

/**
 * The state hash this timeline produces. Pinned by the Node test, compared
 * against by the browser. Changing the handling constants changes this number,
 * and that invalidates every previously stored run.
 */
export const CANON_HASH = 988202808;
