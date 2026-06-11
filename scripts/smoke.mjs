#!/usr/bin/env node
// End-to-end smoke test for the game server. Boots `wrangler dev`, connects
// real WebSocket clients, and walks through the whole gameplay protocol:
// join/roster, movement validation, server-side hitscan, death/respawn,
// speed-hack rejection, fire-rate cap, reconnect-with-token, and the room cap.
//
// Run with: npm run test:server   (requires `npm run build` output in dist/)

import { spawn } from "node:child_process";
import process from "node:process";

const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;
const WS_URL = `ws://127.0.0.1:${PORT}/ws`;

// Mirrors src/shared/map.ts SPAWN_POINTS, in ring order around the arena.
const RING = [
  [8, -29],
  [20, -20],
  [22, 0],
  [20, 20],
  [0, 22],
  [-20, 20],
  [-22, 0],
  [-20, -20],
];

const failures = [];
let passes = 0;

function ok(cond, label) {
  if (cond) {
    passes++;
    console.log(`  ✓ ${label}`);
  } else {
    failures.push(label);
    console.error(`  ✗ ${label}`);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

class Client {
  constructor(label, url = WS_URL) {
    this.label = label;
    this.url = url;
    this.messages = [];
    this.closed = false;
    this.closeCode = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.ws.addEventListener("open", () => resolve());
      this.ws.addEventListener("error", () => reject(new Error(`${this.label}: ws error`)));
      this.ws.addEventListener("close", (ev) => {
        this.closed = true;
        this.closeCode = ev.code;
      });
      this.ws.addEventListener("message", (ev) => {
        try {
          this.messages.push(JSON.parse(ev.data));
        } catch {
          // ignore non-JSON
        }
      });
    });
  }

  send(obj) {
    this.ws.send(JSON.stringify(obj));
  }

  /** Wait for the first message matching pred at index >= from. Returns [msg, index]. */
  async waitFor(pred, { timeout = 5000, from = 0 } = {}) {
    const deadline = Date.now() + timeout;
    let i = from;
    for (;;) {
      for (; i < this.messages.length; i++) {
        if (pred(this.messages[i])) return [this.messages[i], i];
      }
      if (Date.now() > deadline) {
        throw new Error(`${this.label}: timeout waiting for message (have ${this.messages.length})`);
      }
      await sleep(25);
    }
  }

  cursor() {
    return this.messages.length;
  }

  async join(name, token) {
    await this.connect();
    this.send({ type: "join", v: 3, name, ...(token ? { token } : {}) });
    const [welcome] = await this.waitFor((m) => m.type === "welcome" || m.type === "full");
    // Keep-alive pings like the real client, or the 30s idle kick fires on
    // long test runs.
    this.pinger = setInterval(() => {
      if (!this.closed) this.send({ type: "ping", t: Date.now() });
    }, 5000);
    return welcome;
  }

  close() {
    clearInterval(this.pinger);
    try {
      this.ws.close();
    } catch {
      // already closed
    }
  }
}

/** Walk a client along the spawn ring from its position to a target ring vertex. */
async function walk(client, welcome, targetIdx, stopShortOf = null) {
  const start = [welcome.spawn[0], welcome.spawn[2]];
  let idx = RING.findIndex(([x, z]) => Math.abs(x - start[0]) < 0.1 && Math.abs(z - start[1]) < 0.1);
  if (idx === -1) throw new Error(`spawn ${start} not on ring`);

  // Shortest direction around the ring.
  const n = RING.length;
  const fwd = (targetIdx - idx + n) % n;
  const back = (idx - targetIdx + n) % n;
  const step = fwd <= back ? 1 : -1;

  let pos = [...start];
  const send = async (x, z) => {
    client.send({ type: "input", p: [x, 0, z], yaw: 0, pitch: 0, e: welcome.e });
    await sleep(100);
  };

  while (idx !== targetIdx) {
    const next = RING[(idx + step + n) % n];
    // Sub-steps of <= 0.8m keep us under the server's speed allowance.
    const dx = next[0] - pos[0];
    const dz = next[1] - pos[1];
    const distTotal = Math.hypot(dx, dz);
    const steps = Math.ceil(distTotal / 0.8);
    const isLastLeg = (idx + step + n) % n === targetIdx;
    const stopSteps = isLastLeg && stopShortOf ? Math.max(1, steps - Math.ceil(stopShortOf / 0.8)) : steps;
    for (let i = 1; i <= stopSteps; i++) {
      await send(pos[0] + (dx * i) / steps, pos[1] + (dz * i) / steps);
    }
    pos = isLastLeg && stopShortOf ? [pos[0] + (dx * stopSteps) / steps, pos[1] + (dz * stopSteps) / steps] : [...next];
    idx = (idx + step + n) % n;
  }
  return pos;
}

async function waitForServer() {
  for (let i = 0; i < 120; i++) {
    try {
      const res = await fetch(`${BASE}/api/status`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await sleep(500);
  }
  throw new Error("wrangler dev never became ready");
}

async function main() {
  console.log("Starting wrangler dev…");
  const wrangler = spawn("npx", ["wrangler", "dev", "--port", String(PORT)], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  let serverLog = "";
  wrangler.stdout.on("data", (d) => (serverLog += d));
  wrangler.stderr.on("data", (d) => (serverLog += d));

  const cleanup = () => {
    try {
      process.kill(-wrangler.pid, "SIGTERM");
    } catch {
      // already gone
    }
  };
  process.on("exit", cleanup);

  try {
    await waitForServer();
    console.log("Server ready.\n");

    // --- status endpoint -------------------------------------------------------
    console.log("status endpoint");
    const empty = await (await fetch(`${BASE}/api/status`)).json();
    ok(empty.players === 0 && empty.max === 10, "empty room reports 0/10");

    // --- join & roster ----------------------------------------------------------
    console.log("join & roster");
    const alice = new Client("alice");
    const wA = await alice.join("Alice");
    ok(wA.type === "welcome", "Alice receives welcome");
    ok(typeof wA.id === "string" && typeof wA.token === "string", "welcome carries id + token");
    ok(Array.isArray(wA.spawn) && wA.hp === 100, "welcome carries spawn + hp");
    ok(wA.roster.length === 1 && wA.roster[0].name === "Alice", "roster lists Alice");

    const bob = new Client("bob");
    const cA = alice.cursor();
    const wB = await bob.join("Bob");
    ok(wB.type === "welcome", "Bob receives welcome");
    const [rosterMsg] = await alice.waitFor((m) => m.type === "roster" && m.players.length === 2, { from: cA });
    ok(rosterMsg.players.some((p) => p.name === "Bob"), "Alice is told about Bob joining");

    const both = await (await fetch(`${BASE}/api/status`)).json();
    ok(both.players === 2, "status reports 2 players");

    // --- state broadcasts --------------------------------------------------------
    console.log("state broadcasts");
    const [state] = await bob.waitFor((m) => m.type === "state" && m.players.length === 2);
    ok(state.players.every((p) => p.hp === 100 && !p.dead), "state snapshot shows both alive at 100hp");

    // --- movement: Bob walks to Alice -----------------------------------------------
    console.log("movement (server accepts legal steps)");
    const aliceIdx = RING.findIndex(
      ([x, z]) => Math.abs(x - wA.spawn[0]) < 0.1 && Math.abs(z - wA.spawn[2]) < 0.1,
    );
    ok(aliceIdx !== -1, "Alice spawned on a known spawn point");
    const bobPos = await walk(bob, wB, aliceIdx, 4);
    const cS = bob.cursor();
    const [moved] = await bob.waitFor(
      (m) => m.type === "state" && m.players.some((p) => p.id === wB.id),
      { from: cS },
    );
    const bobSnap = moved.players.find((p) => p.id === wB.id);
    const drift = Math.hypot(bobSnap.p[0] - bobPos[0], bobSnap.p[2] - bobPos[1]);
    ok(drift < 0.05, `server accepted Bob's walk (drift ${drift.toFixed(3)}m)`);

    // --- combat: 4 hits = kill --------------------------------------------------------
    console.log("combat (server-validated hitscan)");
    const eye = [bobPos[0], 1.6, bobPos[1]];
    const target = [wA.spawn[0], 0.9, wA.spawn[2]];
    let d = [target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]];
    const len = Math.hypot(...d);
    d = d.map((v) => v / len);

    // Shields absorb the first 50: two shots strip the shield, four more kill.
    const hits = [];
    const shields = [];
    for (let shot = 0; shot < 6; shot++) {
      const c = alice.cursor();
      bob.send({ type: "shoot", o: eye, d, e: wB.e, w: "riveter" });
      const [hit] = await alice.waitFor((m) => m.type === "hit" && m.id === wA.id, { from: c });
      hits.push(hit.hp);
      shields.push(hit.s);
      await sleep(300); // respect the fire-rate cap
    }
    ok(
      JSON.stringify(hits) === "[100,100,75,50,25,0]",
      `hp sequence 100/100/75/50/25/0 (got ${hits})`,
    );
    ok(JSON.stringify(shields) === "[25,0,0,0,0,0]", `shield sequence 25/0/0/0/0/0 (got ${shields})`);

    const [death] = await alice.waitFor((m) => m.type === "death");
    ok(death.id === wA.id && death.by === wB.id, "death event credits Bob");
    const [scored] = await alice.waitFor(
      (m) => m.type === "roster" && m.players.some((p) => p.id === wB.id && p.kills === 1),
    );
    ok(
      scored.players.find((p) => p.id === wA.id)?.deaths === 1,
      "scoreboard: Bob 1 kill, Alice 1 death",
    );

    // --- respawn -------------------------------------------------------------------------
    console.log("respawn");
    const [spawnMsg] = await alice.waitFor((m) => m.type === "spawn" && m.id === wA.id, { timeout: 6000 });
    ok(spawnMsg.hp === 100 && spawnMsg.e === 2, "Alice respawns at full hp with bumped epoch");

    // --- anti-cheat: teleport rejected ------------------------------------------------------
    console.log("anti-cheat");
    bob.send({ type: "input", p: [bobPos[0] + 10, 0, bobPos[1]], yaw: 0, pitch: 0, e: wB.e });
    await sleep(200);
    const cT = bob.cursor();
    const [afterTp] = await bob.waitFor((m) => m.type === "state", { from: cT });
    const tpSnap = afterTp.players.find((p) => p.id === wB.id);
    ok(
      Math.abs(tpSnap.p[0] - bobPos[0]) < 0.05,
      `10m teleport rejected (server kept x=${tpSnap.p[0]})`,
    );

    // Fly-cheat: claiming y=3 from the ground exceeds the jump-apex allowance.
    bob.send({ type: "input", p: [bobPos[0], 3, bobPos[1]], yaw: 0, pitch: 0, e: wB.e });
    await sleep(200);
    const cY = bob.cursor();
    const [afterFly] = await bob.waitFor((m) => m.type === "state", { from: cY });
    const flySnap = afterFly.players.find((p) => p.id === wB.id);
    ok(flySnap.p[1] < 0.05, `fly to y=3 rejected (server kept y=${flySnap.p[1]})`);

    // Fire-rate: 3 instant shoot messages -> only 1 validated shot broadcast.
    const cF = alice.cursor();
    for (let i = 0; i < 3; i++) {
      bob.send({ type: "shoot", o: eye, d: [0, 0, -1], e: wB.e, w: "riveter" });
    }
    await sleep(600);
    const burstShots = alice.messages
      .slice(cF)
      .filter((m) => m.type === "shot" && m.id === wB.id).length;
    ok(burstShots === 1, `rapid burst of 3 -> ${burstShots} accepted shot (cooldown enforced)`);

    // --- reconnect with token ----------------------------------------------------------------
    console.log("reconnect");
    bob.close();
    await alice.waitFor((m) => m.type === "roster" && m.players.length === 1);
    ok(true, "Alice sees Bob leave");

    const bob2 = new Client("bob2");
    const wB2 = await bob2.join("Bob", wB.token);
    ok(wB2.type === "welcome", "Bob reconnects with token");
    const rejoined = wB2.roster.find((p) => p.id === wB2.id);
    ok(rejoined?.kills === 1, `reconnect restores score (kills=${rejoined?.kills})`);

    // --- weapons & pickups -----------------------------------------------------------------
    console.log("weapons & pickups");
    const carol = new Client("carol");
    const wC = await carol.join("Carol");
    ok(
      Array.isArray(wC.items) && wC.items.length === 14 && wC.items.every((it) => it.avail),
      "welcome lists 14 available pickups (weapons, medkits, power-ups, secrets)",
    );

    // Walk to the Armory counter and reach over it for the Scrapshot (item 0).
    await walk(carol, wC, 0); // ring node (8,-29)
    const approach = [
      [8, -27.5],
      [3, -27.8],
      [-2.2, -27.9],
      [-2.2, -28.45],
    ];
    let cur = [wC.spawn[0], wC.spawn[2]];
    cur = [8, -29];
    for (const [tx, tz] of approach) {
      const segDist = Math.hypot(tx - cur[0], tz - cur[1]);
      const steps = Math.max(1, Math.ceil(segDist / 0.7));
      for (let i = 1; i <= steps; i++) {
        carol.send({
          type: "input",
          p: [cur[0] + ((tx - cur[0]) * i) / steps, 0, cur[1] + ((tz - cur[1]) * i) / steps],
          yaw: 0,
          pitch: 0,
          e: wC.e,
        });
        await sleep(100);
      }
      cur = [tx, tz];
    }
    const [pickupMsg] = await carol.waitFor((m) => m.type === "pickup");
    ok(
      pickupMsg.w === "scrapshot" && pickupMsg.ammo === 8,
      `counter pickup grants scrapshot with 8 shells (got ${pickupMsg.w}/${pickupMsg.ammo})`,
    );
    const [itemMsg] = await alice.waitFor((m) => m.type === "item" && m.id === 0 && !m.avail);
    ok(itemMsg.id === 0, "item 0 broadcast as taken to everyone");

    // Scrapshot fires 7 server-rolled pellets.
    const cP = alice.cursor();
    carol.send({ type: "shoot", o: [cur[0], 1.6, cur[1]], d: [0, 0, 1], e: wC.e, w: "scrapshot" });
    const [scrapShot] = await alice.waitFor(
      (m) => m.type === "shot" && m.w === "scrapshot",
      { from: cP },
    );
    ok(scrapShot.rays.length === 7, `scrapshot broadcast carries 7 rays (got ${scrapShot.rays.length})`);

    // An unowned weapon is rejected outright.
    const cU = alice.cursor();
    carol.send({ type: "shoot", o: [cur[0], 1.6, cur[1]], d: [0, 0, 1], e: wC.e, w: "arcwelder" });
    await sleep(400);
    const arcShots = alice.messages.slice(cU).filter((m) => m.type === "shot" && m.w === "arcwelder");
    ok(arcShots.length === 0, "shooting an unowned weapon is rejected");

    // Grenades: grab the frag charges from the counter centre, lob one south,
    // and watch it appear in state snapshots then detonate.
    const stepsToFrag = [
      [-1.4, -28.45],
      [-0.7, -28.45],
      [0, -28.45],
    ];
    for (const [tx, tz] of stepsToFrag) {
      carol.send({ type: "input", p: [tx, 0, tz], yaw: 0, pitch: 0, e: wC.e });
      await sleep(100);
    }
    const [fragPickup] = await carol.waitFor((m) => m.type === "pickup" && m.w === "frag");
    ok(fragPickup.ammo === 3, `counter pickup grants 3 frag charges (got ${fragPickup.ammo})`);

    await sleep(1000); // clear the weapon cooldown from the scrapshot test
    const cN = carol.cursor();
    carol.send({ type: "shoot", o: [0, 1.6, -28.45], d: [0, 0.2, 0.98], e: wC.e, w: "frag" });
    const [nadeState] = await carol.waitFor(
      (m) => m.type === "state" && Array.isArray(m.nades) && m.nades.length > 0,
      { from: cN },
    );
    ok(nadeState.nades.length === 1, "live grenade appears in state snapshots");
    const [boom] = await carol.waitFor((m) => m.type === "boom", { from: cN, timeout: 4000 });
    ok(boom.by === wC.id, "grenade detonates with thrower attribution");

    // Lava: wade into the north pool and take environmental damage.
    let lz = -28.45;
    while (lz < -13.5) {
      lz = Math.min(-13.5, lz + 0.7);
      carol.send({ type: "input", p: [0, 0, lz], yaw: 0, pitch: 0, e: wC.e });
      await sleep(100);
    }
    const [lavaHit] = await carol.waitFor(
      (m) => m.type === "hit" && m.id === wC.id && m.by === "env:lava",
      { timeout: 4000 },
    );
    ok(lavaHit.s < 50, `lava ticks environmental damage (shield ${lavaHit.s})`);

    carol.close();
    await alice.waitFor((m) => m.type === "roster" && m.players.length === 2);

    // --- practice mode (bots) ----------------------------------------------------------------
    console.log("practice mode");
    const solo = new Client("solo", `${WS_URL}?room=solo-smoketest0001`);
    const wS = await solo.join("Hermit");
    ok(wS.type === "welcome", "practice room join succeeds");
    ok(wS.roster.length === 4, `practice roster has 1 human + 3 bots (got ${wS.roster.length})`);

    const [s1] = await solo.waitFor((m) => m.type === "state" && m.players.length === 4);
    await sleep(1600);
    const cB = solo.cursor();
    const [s2] = await solo.waitFor((m) => m.type === "state", { from: cB });
    const botMoved = s1.players.some((p1) => {
      if (p1.id === wS.id) return false;
      const p2 = s2.players.find((p) => p.id === p1.id);
      return p2 && Math.hypot(p2.p[0] - p1.p[0], p2.p[2] - p1.p[2]) > 0.3;
    });
    ok(botMoved, "bots roam the arena (position changes between snapshots)");
    solo.close();

    // --- horde mode ---------------------------------------------------------------------------
    console.log("horde mode");
    const hermit = new Client("hermit", `${WS_URL}?room=horde-arena`);
    const wH = await hermit.join("Hermit");
    ok(wH.type === "welcome", "horde room join succeeds");
    const [incoming] = await hermit.waitFor((m) => m.type === "wave" && m.state === "incoming", {
      timeout: 8000,
    });
    ok(incoming.n === 1, `wave 1 announced (got wave ${incoming.n})`);
    const [withMonsters] = await hermit.waitFor(
      (m) => m.type === "state" && Array.isArray(m.m) && m.m.length > 0,
      { timeout: 12000 },
    );
    ok(withMonsters.m[0].k === "fiend", `monsters spawn (first is a ${withMonsters.m[0].k})`);
    const firstPos = withMonsters.m[0].p;
    await sleep(2000);
    const cH = hermit.cursor();
    const [later] = await hermit.waitFor(
      (m) => m.type === "state" && Array.isArray(m.m) && m.m.some((x) => x.id === withMonsters.m[0].id),
      { from: cH, timeout: 5000 },
    );
    const same = later.m.find((x) => x.id === withMonsters.m[0].id);
    const crept = Math.hypot(same.p[0] - firstPos[0], same.p[2] - firstPos[2]);
    ok(crept > 1, `fiend hunts the player (moved ${crept.toFixed(1)}m)`);
    hermit.close();

    // --- room cap ------------------------------------------------------------------------------
    console.log("room cap");
    const extras = [];
    for (let i = 0; i < 8; i++) {
      const c = new Client(`extra${i}`);
      const w = await c.join(`Extra${i}`);
      ok(w.type === "welcome", `Extra${i} joins (${4 + i}…10 players)`);
      extras.push(c);
    }
    const fullStatus = await (await fetch(`${BASE}/api/status`)).json();
    ok(fullStatus.players === 10, "room is at 10/10");

    const eleventh = new Client("eleventh");
    const wFull = await eleventh.join("Unlucky");
    ok(wFull.type === "full" && wFull.max === 10, "11th player gets a friendly 'full' rejection");
    await sleep(300);
    ok(eleventh.closed, "11th player's socket is closed");

    // --- teardown ---------------------------------------------------------------------------------
    alice.close();
    bob2.close();
    eleventh.close();
    for (const c of extras) c.close();
  } catch (err) {
    failures.push(String(err));
    console.error(`\nFATAL: ${err.message ?? err}`);
    console.error("--- last server log ---");
    console.error(serverLog.split("\n").slice(-25).join("\n"));
  } finally {
    cleanup();
  }

  console.log(`\n${passes} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    for (const f of failures) console.error(`  FAILED: ${f}`);
    process.exit(1);
  }
}

main();
