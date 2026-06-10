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
  [0, -21],
  [14, -14],
  [21, 0],
  [14, 14],
  [0, 21],
  [-14, 14],
  [-21, 0],
  [-14, -14],
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
  constructor(label) {
    this.label = label;
    this.messages = [];
    this.closed = false;
    this.closeCode = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(WS_URL);
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
    this.send({ type: "join", v: 1, name, ...(token ? { token } : {}) });
    const [welcome] = await this.waitFor((m) => m.type === "welcome" || m.type === "full");
    return welcome;
  }

  close() {
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

    const hits = [];
    for (let shot = 0; shot < 4; shot++) {
      const c = alice.cursor();
      bob.send({ type: "shoot", o: eye, d, e: wB.e });
      const [hit] = await alice.waitFor((m) => m.type === "hit" && m.id === wA.id, { from: c });
      hits.push(hit.hp);
      await sleep(300); // respect the fire-rate cap
    }
    ok(JSON.stringify(hits) === "[75,50,25,0]", `hp sequence 75/50/25/0 (got ${hits})`);

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
    for (let i = 0; i < 3; i++) bob.send({ type: "shoot", o: eye, d: [0, 0, -1], e: wB.e });
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
