// npm run queue -- [YYYY-MM-DD] [days]
//
// Prints and checks the upcoming puzzle queue (SPEC.md §12). Exits non-zero on
// any bad day, so this is the thing to run before a release or on a schedule:
// a broken generation should be a red console days ahead of its date, never a
// live incident on the morning it lands.

import { puzzleFor, validateQueue } from '../sim/daily.js';
import { TICK_HZ } from '../sim/index.js';
import { localDate, puzzleNumber } from '../sim/puzzle.js';

const from = process.argv[2] ?? localDate();
const days = Number(process.argv[3] ?? 30);

const clock = (ticks: number) => {
  const s = ticks / TICK_HZ;
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
};

console.log(`Doordle queue: ${days} days from ${from}\n`);
console.log('  #     date         district      par     orders  status');

const queue = validateQueue(from, days);
for (const c of queue) {
  const p = puzzleFor(c.date);
  const row = [
    String(puzzleNumber(c.date)).padStart(5),
    c.date.padEnd(12),
    p.district.name.padEnd(13),
    clock(c.par.ticks).padStart(6),
    String(p.orders.length).padStart(6),
  ].join(' ');
  console.log(`${row}  ${c.ok ? 'ok' : `BAD: ${c.problems.join('; ')}`}`);
}

const bad = queue.filter((c) => !c.ok);
const pars = queue.map((c) => c.par.ticks / TICK_HZ).filter(Number.isFinite);
console.log(
  `\n${queue.length - bad.length}/${queue.length} playable · par ` +
    `${Math.min(...pars).toFixed(1)}s to ${Math.max(...pars).toFixed(1)}s · ` +
    `median ${pars.sort((a, b) => a - b)[pars.length >> 1].toFixed(1)}s`,
);

if (bad.length) {
  console.error(`\n${bad.length} day(s) need attention before they go live.`);
  process.exit(1);
}
