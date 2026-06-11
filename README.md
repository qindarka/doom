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

- Pointer-lock mouse look, WASD, Space to jump, auto-step up stairs, **jump
  pads** onto the decks and bastion, **teleporter pads** linking opposite
  corners, and an **elevator** up to the south sniper ledge.
- **Halo-style energy shield over Doom-style health**: the shield absorbs
  damage first and recharges after 5s out of combat; health only heals via
  medkits. Retreat, recharge, re-engage.
- **Six weapons.** The infinite **Riveter** is always with you; grab the rest
  at the **Armory** counter or field spawns:
  - **Scrapshot** — 7-pellet scatter gun (8 shells)
  - **Arcwelder** — 70-damage precision beam (5 charges)
  - **Frag Charge** — bouncing grenade, 2s fuse, walls shield the blast
  - **Pyrelance** — rockets that detonate on impact (4 rockets)
  - **The Smelter** — a 200-damage super-cannon hidden in the secret chamber,
    announced arena-wide when it comes online (every 150s)
  - Switch with **1–6** or cycle with **Ctrl** (Windows and macOS).
- **Power-ups**: Overdrive (×2 damage), Afterburners (×1.4 speed — the server
  validates the boost), Overshield (double shield), and medkits.
- **Lava pools** flank the bastion: 10 damage/sec, and yes, the killfeed
  credits THE SLAG.
- **A secret**: the bastion is hollow. Shoot the discolored panel on its north
  face and the door slides open — overshield and the Smelter live inside.
  "SECRET FOUND" awaits the first-timer.
- **Matches**: first to 20 points wins (frags + bastion-control bonuses:
  hold the roof alone for 10s for +1). Podium screen, then a fresh arena.
- **Killstreaks**: DOUBLE FRAG through OVERKILL, KILLING SPREE through GODLIKE,
  with arena-wide announcements; deaths burst into bouncing armor gibs.
- **Server-validated combat.** Clients only *claim* shots; the Durable Object
  re-raycasts every pellet, simulates every projectile, and enforces
  fire-rate, ammo, muzzle-origin, movement-speed, anti-fly and wall-embedding
  checks (including the sliding door and the moving elevator).
- Health states are unmissable: OPTIMAL → DAMAGED → CRITICAL, a closing red
  vignette, an audible heartbeat below 30.
- Live scoreboard (hold **Tab**) — mirrored on the **jumbotron** with a ticker
  of frags, streaks, and events.
- **Practice mode**: a private arena against 3 AI bots that roam waypoints,
  strafe, lob grenades, and shop for weapons.
- **HORDE CO-OP**: one shared arena where you and your friends fight waves of
  monsters together (friendly fire off) — charging **Scrap Fiends**, flying
  **Welder Drones** with plasma bolts, and every 5th wave the **Foundry
  Warden**, a boss with a telegraphed area slam you must dodge. Monsters pour
  from wall vents; the fallen revive when the wave is cleared; a full wipe ends
  the run with a "SURVIVED TO WAVE N" tally.
- Generative, key-free industrial ambient soundtrack (toggle **M**); ember sky
  and drifting ash. All audio synthesized, all textures procedural — the repo
  contains zero binary assets.
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
