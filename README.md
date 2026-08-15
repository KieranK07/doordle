# Doordle

A daily browser game. One run per day, everyone races the same delivery route, fastest time wins.

Live at [doordle.chadnerd.lol](https://doordle.chadnerd.lol). Design and build
order: [SPEC.md](SPEC.md).

```
npm run dev      vite on :5173
npm test         typecheck + vitest
npm run queue    check the next 30 days of puzzles
npm run growth   should the city grow?
npm run deploy   build and push to Cloudflare
```

Status: all seven phases done. Playable, scored server-side, one run per
account per day, with worldwide daily and rolling 30-day boards, percentiles,
streaks and a share card. Puzzles are generated from the date, validated before
they ship, and rotate through nine districts. The city grows by appending a
dated row to `GROWTH_LOG`, which never disturbs a coordinate anyone has already
learned. Sign-in returns 503 until the Google OAuth secrets are set, and
everything else works without them.
