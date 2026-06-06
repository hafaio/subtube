# subtube — project context

A personal, subscription-driven YouTube reader. Pulls recent uploads (or
playlists) from the channels you actually subscribe to (official Data API),
applies rich per-channel filters (title/description **regex**, min duration,
live/VOD, Shorts), offers per-channel **pages**, tracks **watched** state
yourself (YouTube exposes no watch history via API), and plays videos through the
official **IFrame embed** so ads still serve. No algorithm, no recommendations,
no comments — just consumption.

## Stack & conventions

Mirrors `../hafaio.github.io` (tooling) and `../done` (Firebase): Next 15 App
Router with `output: "export"` (static), React 19, Tailwind 4 (CSS-first:
`@import "tailwindcss"`), biome (double quotes, organized imports, 2-space), bun.
Deploys to GitHub Pages via `.github/workflows/` (reusable `build` + manual
`deploy`). Firebase **Functions** (Node 24, ESM, v2 callables) hold the YouTube
OAuth refresh flow + Shorts probe.

- `bun dev` — dev server. NOTE: the dev port must be an **Authorized JavaScript
  origin** *and* **redirect URI** on the OAuth client, or the connect popup
  fails. 3000 is often taken → it falls back to 3001, so authorize whichever port
  it uses.
- `bun run lint` — `tsc && biome check`. `bun run fmt` — biome format.
- `bun export` — static export to `out/` (don't run while `bun dev` is up; it
  clobbers `.next`).
- Functions: `firebase deploy --only functions` (needs `functions/.env` with
  `YT_OAUTH_CLIENT_ID`/`YT_OAUTH_CLIENT_SECRET`, gitignored).

## Architecture

- `src/config.ts` — `firebaseConfig` + `oauthClientId` (public web config; safe
  to commit — Firestore is gated by `firestore.rules`, not secrecy).
- `src/firebase.ts` — Firebase Auth (identity) + Firestore helpers. `channels/`,
  `watched/` (owner-only); `loadWatchedFor` queries only the loaded ids
  (`documentId() in`, 30/chunk) instead of the whole collection.
- `src/youtube-auth.ts` / `src/youtube-token.ts` — server-side OAuth: the connect
  popup runs the Authorization-Code flow, the code is exchanged in a callable,
  the refresh token is stored server-only, and the in-memory access token is
  silently re-minted via the backend (GIS can't re-mint client-side anymore).
- `functions/src/index.ts` — `exchangeYouTubeCode` / `refreshYouTubeToken` /
  `disconnectYouTube`, plus `classifyShorts` (probes `youtube.com/shorts/{id}`
  server-side, caches verdicts in global server-only `videoMeta/{id}`).
- `src/youtube.ts` — Data API: subscriptions, uploads (`UC`→`UU` playlist),
  playlists, and per-video duration + live status (`videos.list`).
- `src/types.ts` — `FeedItem = Video | Playlist` (discriminated by `kind`).
- `src/filters.ts` — compile + apply per-channel filters (regex/scope/mode,
  duration, live, Shorts) to a `FeedItem`; gates are video-only.
- `src/router.ts` — query-string router: a `channel` background + an optional
  open `item` (video/playlist). `?channel=x&v=y` keeps the channel behind the
  player; Back closes.
- `src/feed-cache.ts` — IndexedDB stale-while-revalidate feed cache.
- `components/feed.tsx` — workhorse: load → `enrichItems` (watched + Shorts) →
  filter/sort grid; channel pages (scoped feed, on-demand fetch for disabled);
  mid-load 401 silent-refreshes once.
- `components/{video-card,playlist-card,channel-filters,player,login,...}.tsx` —
  UI. `next/image` with `images.unoptimized`; thumbnails guarded against empty
  src.

## Key decisions

- **Server-side OAuth** (refresh token in `users/{uid}/private/**`, no client
  rule) instead of GIS silent re-mint, which Google removed. Browser holds only
  short-lived access tokens.
- **Watched is self-tracked** in Firestore (YouTube removed the history API).
- **Shorts via `/shorts/{id}` probe** (no API flag), server-side (CORS), cached
  globally; client reuses cached verdicts so steady state does no work.
- **Playlists/channel pages reuse the feed pipeline**; the broadcast/Shorts gates
  no-op on playlists.
- **Keep the official IFrame player** so ads serve and views count (intentional,
  creator-friendly; not an ad-stripping client like FreeTube/Invidious).

## Status

Feature-complete for the intended scope; lint/typecheck/tests pass. The scaffold
and the Functions backend are merged to `main`; the reader app is the open PR.
Functions (`subtube-dev`, us-central1) and Firestore rules are deployed.

Future work: auto-generate a per-channel regex from a few picked videos (greedy
set-cover over title tokens; minimal-exact is NP-hard); a paginated / infinite
feed (older uploads beyond the first page per channel).

## Gotchas

- Watch-history is self-tracked, not real YouTube history.
- Silent refresh needs an active Google session + prior consent; otherwise a
  one-click interactive Reconnect appears.
- Esc can't reach the app while the cross-origin player iframe has focus — Back
  (URL-driven) closes the player reliably.
- Shorts detection relies on undocumented `/shorts/{id}` redirect behavior;
  changing the probe logic means clearing `videoMeta` (no cache version).
- Comparable tools: Feedvault (paid, no regex/own-sync), FreeTube (ad-stripping
  desktop), Unhook (extension). subtube's niche = rich per-channel filters + own
  cloud sync + ad-serving player.
