# Subtube

A personal, subscription-driven YouTube reader: per-channel filters,
self-tracked watched state, and playback through the official embed.

## Develop

```sh
bun install
bun dev          # next dev --turbo  (authorize whatever port it picks)
bun run lint     # tsc && biome check
bun test         # bun:test unit specs
bun run fmt      # biome format --write
bun export       # static export to ./out  (don't run while `bun dev` is up)
```

`functions/.env` is gitignored, so recreate it on a fresh checkout with
`YT_OAUTH_CLIENT_ID` / `YT_OAUTH_CLIENT_SECRET` (needed to deploy Functions).
