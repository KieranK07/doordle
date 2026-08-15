// Phase 5: leaderboards. Worldwide only (SPEC.md §5) — one daily table, one
// rolling 30-day table, plus your percentile, your streak, and past winners.
//
// Players are identified by their house number, never by email. The house is
// already permanent, already theirs, and already on the map, so it makes a
// stable public handle with no personal data attached to it.

/** Day 1. Every share card counts from here. */
export const EPOCH = '2026-08-01';

const DAY = 86_400_000;
const stamp = (date: string) => Date.parse(`${date}T00:00:00Z`);

export const puzzleNumber = (date: string) => Math.round((stamp(date) - stamp(EPOCH)) / DAY) + 1;

export function shiftDate(date: string, days: number): string {
  return new Date(stamp(date) + days * DAY).toISOString().slice(0, 10);
}

/** Rounded up, floored at 1, so the fastest player reads "Top 1%" not "Top 0%". */
export const percentileOf = (rank: number, total: number) =>
  total < 1 ? 100 : Math.max(1, Math.ceil((rank / total) * 100));

/**
 * Consecutive days with a completed run, counting back from `today`. A streak
 * requires finishing, not just loading the page (SPEC.md §5), which is free
 * here because only finished runs are ever stored.
 */
export function streakFrom(dates: readonly string[], today: string): number {
  const played = new Set(dates);
  let n = 0;
  for (let day = today; played.has(day); day = shiftDate(day, -1)) n++;
  return n;
}

// -------------------------------------------------------------------- board

/** How many days back the cumulative board averages, and the minimum to appear. */
const WINDOW_DAYS = 30;
const MIN_DAYS = 5;
const TOP_N = 20;

export type BoardRow = { rank: number; slot: number; finishTick: number };
export type AvgRow = { rank: number; slot: number; avgTick: number; days: number };

export type Board = {
  date: string;
  number: number;
  you: { slot: number; rank: number; total: number; percentile: number; finishTick: number; streak: number };
  daily: BoardRow[];
  monthly: AvgRow[];
  winners: { date: string; number: number; slot: number; finishTick: number }[];
};

/**
 * Everything the results screen shows, in one round trip. Callers must have
 * already checked that this player has a run on this date: the board is locked
 * until you submit (SPEC.md §9), and that check is the lock.
 */
export async function buildBoard(
  db: D1Database,
  userId: string,
  date: string,
  mine: number,
  utcToday: string,
): Promise<Board> {
  const since = shiftDate(date, -(WINDOW_DAYS - 1));

  const [daily, standing, monthly, played, winners, house] = await db.batch([
    db
      .prepare(
        `SELECT h.slot AS slot, r.finish_tick AS finish_tick
           FROM runs r JOIN house_claims h ON h.user_id = r.user_id
          WHERE r.date = ? ORDER BY r.finish_tick, r.created_at LIMIT ?`,
      )
      .bind(date, TOP_N),
    // Ties go to whoever got there first, matching the ORDER BY above.
    db
      .prepare(
        `SELECT COUNT(*) AS total, SUM(CASE WHEN finish_tick < ? THEN 1 ELSE 0 END) AS faster
           FROM runs WHERE date = ?`,
      )
      .bind(mine, date),
    db
      .prepare(
        `SELECT h.slot AS slot, AVG(r.finish_tick) AS avg_tick, COUNT(*) AS days
           FROM runs r JOIN house_claims h ON h.user_id = r.user_id
          WHERE r.date BETWEEN ? AND ?
          GROUP BY r.user_id HAVING days >= ?
          ORDER BY avg_tick LIMIT ?`,
      )
      .bind(since, date, MIN_DAYS, TOP_N),
    db
      .prepare('SELECT date FROM runs WHERE user_id = ? ORDER BY date DESC LIMIT 400')
      .bind(userId),
    // A day is only closed, and only has a winner, once UTC midnight has passed
    // it (SPEC.md §9). SQLite hands back the row that produced the MIN(), which
    // is why slot can ride along beside an aggregate here.
    db
      .prepare(
        `SELECT r.date AS date, h.slot AS slot, MIN(r.finish_tick) AS finish_tick
           FROM runs r JOIN house_claims h ON h.user_id = r.user_id
          WHERE r.date < ? GROUP BY r.date ORDER BY r.date DESC LIMIT 10`,
      )
      .bind(utcToday),
    db.prepare('SELECT slot FROM house_claims WHERE user_id = ?').bind(userId),
  ]);

  const counts = (standing.results[0] ?? {}) as { total?: number; faster?: number };
  const total = Number(counts.total ?? 0);
  const rank = Number(counts.faster ?? 0) + 1;

  return {
    date,
    number: puzzleNumber(date),
    you: {
      slot: Number((house.results[0] as { slot?: number } | undefined)?.slot ?? -1),
      rank,
      total,
      percentile: percentileOf(rank, total),
      finishTick: mine,
      streak: streakFrom((played.results as { date: string }[]).map((r) => r.date), date),
    },
    daily: (daily.results as { slot: number; finish_tick: number }[]).map((r, i) => ({
      rank: i + 1,
      slot: r.slot,
      finishTick: r.finish_tick,
    })),
    monthly: (monthly.results as { slot: number; avg_tick: number; days: number }[]).map((r, i) => ({
      rank: i + 1,
      slot: r.slot,
      avgTick: Math.round(r.avg_tick),
      days: r.days,
    })),
    winners: (winners.results as { date: string; slot: number; finish_tick: number }[]).map((r) => ({
      date: r.date,
      number: puzzleNumber(r.date),
      slot: r.slot,
      finishTick: r.finish_tick,
    })),
  };
}
