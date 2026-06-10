# FERROFRAG

A browser-based multiplayer arena FPS for you and up to 9 friends. No installs, no
logins — share a link, type a callsign, frag. An original boomer-shooter homage:
one dark industrial arena, one hitscan rivet gun, a live scoreboard.

**Stack:** Three.js + vanilla TypeScript client · Cloudflare Workers + one Durable
Object as the authoritative game server · WebSockets · deployed automatically from
GitHub via Cloudflare's git integration (Workers Builds).

```
Browser ──(static assets)──► Cloudflare Worker (Workers Static Assets)
Browser ◄──(WebSocket /ws)──► GameRoom Durable Object  ← one shared room,
                                                          authoritative state
```

A single Worker serves both the built client *and* the realtime backend, so the
WebSocket is same-origin and one `git push` deploys everything atomically.

## Gameplay

- Pointer-lock mouse look, WASD movement, Space to jump, auto-step up stairs —
  fast arena movement across two height levels (decks, the central bastion).
- **Four weapons.** The infinite **Riveter** (25 dmg, ~4/sec) is always with
  you; grab the rest at the **Armory** counter or at field spawns (respawn 20s):
  - **Scrapshot** — 7-pellet scatter gun, brutal up close (8 shells)
  - **Arcwelder** — 70-damage precision beam (5 charges)
  - **Frag Charge** — thrown grenade with real physics: bounces, 2s fuse, 6m
    splash that walls actually shield you from (3 charges)
  - Switch with **1–4** or cycle with **Ctrl** (Windows and macOS).
- **Medkits** (+50 integrity) under each side deck and one exposed mid-field;
  only consumable while hurt.
- **Server-validated combat.** Clients only *claim* shots; the Durable Object
  re-raycasts every pellet against its own view of the world, simulates every
  grenade itself, and enforces fire-rate, ammo, muzzle-origin, movement-speed,
  anti-fly and wall-embedding checks.
- Health states are unmissable: the integrity panel shifts OPTIMAL → DAMAGED →
  CRITICAL, a red vignette closes in as you near death, and your heartbeat gets
  audible below 30.
- Die → killfeed + death screen → auto-respawn after 3s at the spawn point
  farthest from living enemies (pickups drop on death).
- Live scoreboard (hold **Tab**) — also mirrored on the **jumbotron** above the
  central bastion, with the latest frag on its ticker.
- **Practice mode**: one click on the landing page drops you into a private
  arena against 3 AI bots that roam waypoints, take cover-aware shots, lob
  grenades at mid-range, and grab pickups.
- Generative, key-free industrial ambient soundtrack (toggle **M**) — sparse on
  the menu, heartbeat-pulse layer in the arena. All audio is synthesized; the
  repo contains zero binary assets.
- Room cap of 10; extra players get a friendly "room full" message.
- Drop and reconnect within 60s and your score *and* combat state survive
  (reconnect token) — disconnecting is never a heal.

## Project layout

```
index.html              Vite entry page
src/client/             Three.js client (scene+jumbotron, input, movement,
                        weapons/viewmodels, pickups, grenades, interpolated
                        trooper avatars, HUD, generative music, WebAudio sfx)
src/server/index.ts     Worker entry: routes /ws (+?room=solo-*) and /api/status
src/server/GameRoom.ts  The Durable Object: roster, 20Hz tick, hitscan + grenade
                        simulation, pickups, anti-cheat, practice bots
src/server/bots.ts      Bot navigation graph + AI state
src/shared/             Protocol, constants, arena geometry, math — imported by
                        BOTH sides so client and server always agree on the map
scripts/smoke.mjs       End-to-end protocol test against `wrangler dev`
scripts/render-test.mjs Headless-browser test (needs `npm i --no-save playwright`)
wrangler.toml           Worker + Durable Object + static assets config
```

## Local development

```bash
npm install
npm run dev        # builds the client, then runs vite (watch) + wrangler dev
```

Open http://localhost:8787 in two browser windows and join with two names.

Other scripts:

```bash
npm run check         # typecheck client + server
npm run build         # typecheck + production client build into dist/client
npm run test:server   # end-to-end smoke test (boots wrangler dev, simulates 11 players)
npm run deploy        # manual deploy fallback (CI/CD below is the normal path)
```

## Deploying: GitHub → Cloudflare (one-time setup)

After this setup, **every push to `main` builds and deploys automatically**. No
manual `wrangler deploy` ever again. Works on the Workers Free plan (the Durable
Object uses SQLite storage, which free supports).

### 1. Create the GitHub repository and push

```bash
git init   # if not already a repo
git add -A
git commit -m "Ferrofrag initial commit"
# create the repo on GitHub (replace OWNER/ferrofrag, --private if you prefer):
gh repo create OWNER/ferrofrag --public --source=. --push
# …or without the gh CLI: create an empty repo on github.com, then
# git remote add origin git@github.com:OWNER/ferrofrag.git && git push -u origin main
```

### 2. Connect the repo to Cloudflare

1. Sign in at https://dash.cloudflare.com (create a free account if needed).
2. Go to **Workers & Pages** → **Create** → **Workers** tab →
   **Import a repository** (Cloudflare may word it "Connect to Git").
3. Authorize the **Cloudflare Workers & Pages** GitHub app and select your
   `ferrofrag` repository. You can scope the app's access to just this repo.

### 3. Configure the build

On the setup screen:

| Setting             | Value                                  |
| ------------------- | -------------------------------------- |
| Project / Worker name | `ferrofrag` (must match `wrangler.toml`) |
| Production branch   | `main`                                  |
| Build command       | `npm run build`                         |
| Deploy command      | `npx wrangler deploy`                   |
| Root directory      | `/` (default)                           |

Cloudflare reads `wrangler.toml` for everything else: the Worker entry point,
the static-assets directory (`dist/client`), and the Durable Object binding +
migration. Click **Save and Deploy**.

### 4. Confirm the Durable Object deployed

After the first build finishes:

1. Open the build's log (Workers & Pages → ferrofrag → **Deployments** /
   **Builds**). In the `wrangler deploy` output you should see the binding:
   `env.GAME_ROOM (GameRoom) — Durable Object` and the migration `v1` being
   applied. Migrations run automatically with the deploy — there is no separate
   step.
2. In the Worker's **Settings** → **Bindings**, confirm a Durable Object binding
   `GAME_ROOM` → class `GameRoom` exists.
3. Hit `https://<your-worker>.workers.dev/api/status` — you should get
   `{"players":0,"max":10}`. That JSON comes *from inside* the Durable Object,
   so it proves the DO is live.

### 5. Get the public link

Your game is at `https://ferrofrag.<your-subdomain>.workers.dev` (enable the
`workers.dev` route under the Worker's Settings → Domains & Routes if it isn't
already). Optionally attach a custom domain there too. Send the link to your
friends — that's the whole onboarding.

### Day-to-day flow

```bash
git commit -am "tune rocket... er, riveter damage"
git push                  # Cloudflare builds + deploys automatically
```

Pushes to non-production branches can run CI builds, but note that Cloudflare
does **not** generate preview URLs for Workers that implement a Durable Object
(a documented limitation). Test branches locally with `npm run dev`, or deploy
them as a separately-named Worker if you want a shareable test link.

> **Note:** deploying restarts the Durable Object, which drops in-progress
> matches; clients auto-reconnect within a few seconds and scores are restored
> from their reconnect tokens' grace window when possible.

## Design notes

- **One room.** Every visitor lands in the same Durable Object instance
  (`idFromName("main-arena")`). The DO holds the roster, positions, health and
  scores in memory, broadcasts consolidated state at 20Hz, and is the only
  authority on damage, death and respawns.
- **Clients are authoritative only over their own movement**, and even that is
  sanity-checked server-side (speed cap per input, arena bounds, no embedding
  inside geometry). Everything combat-related is server-computed.
- **Interpolation.** Remote players render ~120ms in the past, interpolated
  between snapshots, so movement looks smooth at 20Hz.
- **The map is data**, shared by client and server (`src/shared/map.ts`), so the
  world you see is exactly the world the server raycasts against.
- **No assets.** All textures are drawn into canvases at boot; all sounds are
  synthesized with WebAudio. The repo is 100% source code.

## Troubleshooting

- **Build succeeds but the page 404s** — confirm `dist/client` exists in the
  build (the `build` script must run before `wrangler deploy`; check the build
  command is `npm run build`).
- **`Cannot apply new-sqlite-class migration to deleted class` or similar** —
  the migration history in Cloudflare disagrees with `wrangler.toml`. Add a new
  `[[migrations]]` entry with a fresh `tag` rather than editing the old one.
- **WebSocket fails locally under `vite dev`** — use `npm run dev` (wrangler
  serves the client at :8787 and hosts the DO); plain `vite` has no game server
  unless `wrangler dev` is also running (the vite proxy then forwards `/ws`).
- **"Room full" while testing solo** — ghost sockets from hot reloads usually
  age out within ~30s (idle timeout); refresh after that.
