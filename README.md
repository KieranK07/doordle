# Doordle

A daily browser game. One run per day, everyone races the same delivery route, fastest time wins.

Live at [doordle.chadnerd.lol](https://doordle.chadnerd.lol). Design and build
order: [SPEC.md](SPEC.md).

```
npm run dev      vite on :5173
npm test         typecheck + vitest
npm run deploy   build and push to Cloudflare
```

Status: phases 0 to 4 done. Playable, scored server-side, one run per account
per day. Sign-in returns 503 until the Google OAuth secrets are set, and
everything else works without them.
