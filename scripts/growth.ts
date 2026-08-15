// npm run growth -- [YYYY-MM-DD] [days]
//
// Should the city grow? SPEC.md §3 says to decide on playability rather than on
// how full the house pool is: append a ring only when the optimal run for
// players at the edge is over the limit.
//
// This reports; it does not act. Growing means raising CITY_RINGS in
// sim/city.ts and deploying, and that wants a human, because a mistake in the
// append moves houses people already own.

import { CITY, cityBlocks } from '../sim/city.js';
import { DISTRICTS } from '../sim/district.js';
import { GROWTH_LIMIT_S, growthReport, nextRing, outerDistricts } from '../sim/growth.js';
import { houseSlots, localDate } from '../sim/puzzle.js';

const from = process.argv[2] ?? localDate();
const days = Number(process.argv[3] ?? 9);

const r = growthReport(from, days);
const add = nextRing();

console.log(`Doordle growth check, ${days} days from ${from}\n`);
console.log(`  city          ring ${r.rings} · ${r.districts} districts · ${cityBlocks().length} blocks`);
console.log(`  buildings     ${CITY.length}`);
console.log(`  houses        ${houseSlots().length}`);
console.log(`  edge          ${outerDistricts().map((d) => d.name).join(', ')}`);
console.log(`\n  outer run     ${r.meanS.toFixed(1)}s mean over ${r.samples} samples`);
console.log(`  worst         ${r.worstS.toFixed(1)}s (${r.worstWhere})`);
console.log(`  limit         ${GROWTH_LIMIT_S}s`);

console.log(
  r.grow
    ? `\nGROW: outer runs average ${r.meanS.toFixed(1)}s, over the ${GROWTH_LIMIT_S}s limit.\n` +
        `Raise CITY_RINGS to ${r.rings + 1} in sim/city.ts (+${add.districts} districts, ` +
        `+${add.blocks} blocks), repin CANON_HASH, and deploy.`
    : `\nHOLD: outer runs average ${r.meanS.toFixed(1)}s, ` +
        `${(GROWTH_LIMIT_S - r.meanS).toFixed(1)}s of headroom. ` +
        `${DISTRICTS.length} districts is enough.`,
);
