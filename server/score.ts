// Scoring a submitted run. Kept apart from the HTTP layer so it can be tested
// without a Worker, and so the rule that matters is readable in one place:
// the client's claimed time is never trusted, only the replay is.

import { MAX_TICKS, hashState, replay, type InputEvent } from '../sim/index.js';
import { puzzleFor, type Pin, type Puzzle } from '../sim/puzzle.js';

export type Submission = {
  date: string;
  inputEvents: InputEvent[];
  claimedFinishTick: number;
};

export type Verdict =
  | { ok: true; finishTick: number; stateHash: number }
  | { ok: false; reason: string };

/** Dates are YYYY-MM-DD and nothing else. */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A run may be submitted for the player's own local date, which can be a day
 * either side of UTC. Anything further out is someone fishing for a puzzle they
 * should not have yet, or replaying an old one.
 */
export function dateInWindow(date: string, now: Date = new Date()): boolean {
  if (!DATE_RE.test(date)) return false;
  const utc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const day = 86_400_000;
  for (const offset of [-day, 0, day]) {
    if (new Date(utc + offset).toISOString().slice(0, 10) === date) return true;
  }
  return false;
}

/**
 * Replay the timeline and decide the authoritative finish tick.
 *
 * The client's claimedFinishTick is compared, not believed: it exists so a
 * mismatch is visible rather than silently accepted. `home` comes from the
 * account, never from the submission, or a player could nominate a house next
 * to the last dropoff.
 */
export function scoreRun(sub: Submission, home: Pin, now: Date = new Date()): Verdict {
  if (!dateInWindow(sub.date, now)) return { ok: false, reason: 'date out of window' };
  return scoreAgainst({ ...puzzleFor(sub.date), home }, sub);
}

/**
 * The verdict itself, against a puzzle already chosen. Split out so Phase 6's
 * validator can score a queued puzzle, and so the accept path is testable
 * without needing a bot that can drive the real city.
 */
export function scoreAgainst(puzzle: Puzzle, sub: Submission): Verdict {
  if (!Array.isArray(sub.inputEvents)) return { ok: false, reason: 'events must be an array' };
  if (sub.inputEvents.length > 20_000) return { ok: false, reason: 'too many events' };
  if (!Number.isInteger(sub.claimedFinishTick) || sub.claimedFinishTick < 1) {
    return { ok: false, reason: 'bad claimed tick' };
  }
  if (sub.claimedFinishTick >= MAX_TICKS) return { ok: false, reason: 'claimed tick too large' };

  let state;
  try {
    // One tick past the claim. finishTick is stamped inside the step that
    // reaches home, before the tick counter increments, so replaying to exactly
    // the claimed tick would stop one step short of ever observing it.
    //
    // replay() does its own validation of the timeline and throws on anything
    // malformed, which is exactly the behaviour wanted at a trust boundary.
    state = replay(sub.inputEvents, sub.claimedFinishTick + 1, puzzle);
  } catch (err) {
    return { ok: false, reason: `replay rejected: ${(err as Error).message}` };
  }

  if (state.finishTick < 0) return { ok: false, reason: 'run did not finish' };
  if (state.finishTick !== sub.claimedFinishTick) {
    // The player stopped the clock at a different tick than they claimed.
    return { ok: false, reason: 'claimed tick does not match replay' };
  }
  return { ok: true, finishTick: state.finishTick, stateHash: hashState(state) };
}
