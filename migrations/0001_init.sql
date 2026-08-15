-- Phase 4 schema.

CREATE TABLE users (
  id         TEXT PRIMARY KEY,  -- Google's stable subject id, not the email
  email      TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- House assignment. The pool of positions lives in code (houseSlots() in
-- sim/puzzle.ts) because slots are deterministic and never move, so the only
-- thing worth storing is which of them are taken.
CREATE TABLE house_claims (
  slot       INTEGER PRIMARY KEY,
  user_id    TEXT NOT NULL UNIQUE REFERENCES users(id),
  claimed_at TEXT NOT NULL
);

CREATE TABLE runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT NOT NULL REFERENCES users(id),
  date        TEXT NOT NULL,     -- the player's local YYYY-MM-DD
  finish_tick INTEGER NOT NULL,  -- authoritative, from the server's own replay
  state_hash  INTEGER NOT NULL,
  -- The input timeline, which is also exactly what the overlay video needs
  -- (SPEC.md §10). Stored as submitted, after it passed replay.
  timeline    TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

-- One run per account per day, enforced here rather than in application code
-- so a race between two requests cannot produce two runs.
CREATE UNIQUE INDEX runs_one_per_day ON runs (user_id, date);

CREATE INDEX runs_by_day ON runs (date, finish_tick);
