// The authoritative game server: one Durable Object instance holds the entire
// room — roster, positions, health, and combat resolution. Clients stream
// position/rotation at ~20Hz and *claim* shots; the server re-runs every shot
// as a raycast against its own view of the world, so client hit claims are
// never trusted.
//
// WebSockets use the Hibernation API (ctx.acceptWebSocket + webSocketMessage
// handlers). While players are connected a 20Hz tick interval keeps the object
// hot; if the object is ever restarted (deploy, eviction), surviving sockets
// are closed with CLOSE_REJOIN and clients transparently reconnect.

import { DurableObject } from "cloudflare:workers";

import type { Env } from "./index";

import {
  EYE_HEIGHT,
  GRAVITY,
  IDLE_TIMEOUT_MS,
  JUMP_VELOCITY,
  MAX_HEALTH,
  MAX_PLAYERS,
  MOVE_SPEED,
  MOVE_WINDOW_DIST,
  MOVE_WINDOW_MS,
  PLAYER_COLORS,
  PROTOCOL_VERSION,
  RECONNECT_GRACE_MS,
  RESPAWN_DELAY_MS,
  SHOT_ORIGIN_DY,
  SHOT_ORIGIN_TOLERANCE,
  SPEED_SLACK,
  SPEED_TOLERANCE,
  TICK_MS,
  WEAPON_COOLDOWN_MS,
  WEAPON_DAMAGE,
  WEAPON_RANGE,
} from "../shared/constants";
import { ARENA_HALF, SOLIDS, SPAWN_POINTS } from "../shared/map";
import type { SpawnPoint, Vec3 } from "../shared/map";
import { PLAYER_RADIUS } from "../shared/constants";
import { aabbIntersects, distSq, normalize, playerAABB, rayAABB, rayAABBs, vec3 } from "../shared/math";
import {
  CLOSE_FULL,
  CLOSE_IDLE,
  CLOSE_OUTDATED,
  CLOSE_REJOIN,
  CLOSE_REPLACED,
  parseClientMsg,
  type InputMsg,
  type JoinMsg,
  type PlayerScore,
  type PlayerSnapshot,
  type ServerMsg,
  type ShootMsg,
} from "../shared/protocol";

interface Player {
  id: string;
  token: string;
  name: string;
  color: number;
  ws: WebSocket;
  pos: Vec3;
  yaw: number;
  pitch: number;
  hp: number;
  dead: boolean;
  kills: number;
  deaths: number;
  /** Incremented on every (re)spawn; inputs carrying a stale epoch are dropped. */
  epoch: number;
  respawnAt: number | null;
  lastInputAt: number;
  lastSeen: number;
  /** Cumulative altitude gained since last touching a surface (anti-fly). */
  airRise: number;
  /** Milliseconds spent airborne without descending (anti-hover). */
  hoverMs: number;
  /** Sliding-window cumulative horizontal movement (anti-speedhack). */
  windowDist: number;
  windowStart: number;
  /** Token bucket for fire rate (1 token per WEAPON_COOLDOWN_MS, small burst). */
  shotTokens: number;
  shotRefillAt: number;
  /** Simple flood guard. */
  msgCount: number;
  msgWindowAt: number;
}

// Combat state is preserved across a reconnect so closing the socket is never
// an escape hatch: no combat-log healing, no respawn-delay skipping, no
// teleport-to-a-fresh-spawn while being chased.
interface GraceEntry {
  kills: number;
  deaths: number;
  color: number;
  hp: number;
  dead: boolean;
  respawnAt: number | null;
  pos: Vec3;
  yaw: number;
  expiresAt: number;
}

const SHOT_BURST = 1.5;
const MAX_MSGS_PER_SEC = 120;
const JOIN_TIMEOUT_MS = 10_000;
const MAX_PENDING = 16;
const MAX_Y = 12;
/** Player AABB shrink when testing for "embedded in geometry" (float tolerance). */
const EMBED_EPSILON = 0.05;
/** Max altitude gain without touching a surface: jump apex plus slack. */
const MAX_AIR_RISE = (JUMP_VELOCITY * JUMP_VELOCITY) / (2 * GRAVITY) + 0.35;
/** Max ms airborne without descending (a real jump apex dwell is well under this). */
const MAX_HOVER_MS = 700;

export class GameRoom extends DurableObject<Env> {
  private players = new Map<string, Player>();
  private bySocket = new Map<WebSocket, Player>();
  private pending = new Map<WebSocket, number>(); // socket -> connect time, awaiting join
  private grace = new Map<string, GraceEntry>(); // token -> preserved score
  private tickTimer: ReturnType<typeof setInterval> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // If the object was restarted while sockets were hibernating, our in-memory
    // state for them is gone. Close them; clients auto-reconnect and rejoin.
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(CLOSE_REJOIN, "server restarted, please rejoin");
      } catch {
        // already closing
      }
    }
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/status") {
      return Response.json({ players: this.players.size, max: MAX_PLAYERS });
    }

    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    }

    // Cap sockets that have connected but not joined (cheap connection flood).
    if (this.pending.size >= MAX_PENDING) {
      return new Response("Too many pending connections", { status: 503 });
    }

    // Friendly rejection when the room (plus a small pending allowance) is full.
    if (this.players.size >= MAX_PLAYERS && this.pending.size >= 2) {
      return this.rejectFull();
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    this.pending.set(server, Date.now());
    this.ensureTicking();
    return new Response(null, { status: 101, webSocket: client });
  }

  private rejectFull(): Response {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    server.send(JSON.stringify({ type: "full", max: MAX_PLAYERS } satisfies ServerMsg));
    server.close(CLOSE_FULL, "room full");
    return new Response(null, { status: 101, webSocket: client });
  }

  // --- WebSocket event handlers (hibernation API) ----------------------------

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;
    const msg = parseClientMsg(message);
    if (!msg) return;

    const player = this.bySocket.get(ws);
    if (!player) {
      if (msg.type === "join") {
        this.handleJoin(ws, msg);
      } else if (!this.pending.has(ws)) {
        // A socket we have no record of (object restarted): force a clean rejoin.
        ws.close(CLOSE_REJOIN, "unknown session, please rejoin");
      }
      return;
    }

    if (this.floodCheck(player)) return;
    player.lastSeen = Date.now();

    switch (msg.type) {
      case "input":
        this.handleInput(player, msg);
        break;
      case "shoot":
        this.handleShoot(player, msg);
        break;
      case "ping":
        this.send(player.ws, { type: "pong", t: msg.t });
        break;
      case "join":
        // Already joined; ignore duplicate joins on the same socket.
        break;
    }
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    this.dropSocket(ws);
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    this.dropSocket(ws);
  }

  // --- Join / leave ------------------------------------------------------------

  private handleJoin(ws: WebSocket, msg: JoinMsg): void {
    this.pending.delete(ws);

    if (msg.v !== PROTOCOL_VERSION) {
      this.send(ws, { type: "error", reason: "Client is outdated — refresh the page." });
      ws.close(CLOSE_OUTDATED, "protocol mismatch");
      return;
    }

    const name = sanitizeName(msg.name);
    const now = Date.now();

    // Reconnect with a token that maps to a *still-connected* player (e.g. the
    // old socket has not errored out yet): adopt that player, swap the socket.
    if (msg.token) {
      const existing = [...this.players.values()].find((p) => p.token === msg.token);
      if (existing) {
        this.bySocket.delete(existing.ws);
        try {
          existing.ws.close(CLOSE_REPLACED, "replaced by reconnect");
        } catch {
          // already closed
        }
        existing.ws = ws;
        existing.name = name;
        existing.lastSeen = now;
        existing.lastInputAt = now;
        this.bySocket.set(ws, existing);
        this.send(ws, {
          type: "welcome",
          id: existing.id,
          token: existing.token,
          color: existing.color,
          spawn: [existing.pos.x, existing.pos.y, existing.pos.z],
          yaw: existing.yaw,
          e: existing.epoch,
          hp: existing.hp,
          roster: this.roster(),
        });
        this.broadcastRoster();
        return;
      }
    }

    if (this.players.size >= MAX_PLAYERS) {
      this.send(ws, { type: "full", max: MAX_PLAYERS });
      ws.close(CLOSE_FULL, "room full");
      return;
    }

    // Reconnect within the grace window: restore score AND combat state, so a
    // disconnect is never a heal or an escape teleport.
    const graceEntry = msg.token ? this.grace.get(msg.token) : undefined;
    const restored = graceEntry && graceEntry.expiresAt > now ? graceEntry : undefined;
    if (msg.token && restored) this.grace.delete(msg.token);

    let id = crypto.randomUUID().slice(0, 8);
    while (this.players.has(id)) id = crypto.randomUUID().slice(0, 8);
    const token = msg.token && restored ? msg.token : crypto.randomUUID();
    const spawn = this.pickSpawn();

    const player: Player = {
      id,
      token,
      name,
      color: restored?.color ?? this.pickColor(),
      ws,
      pos: restored ? vec3(restored.pos.x, restored.pos.y, restored.pos.z) : vec3(spawn.pos.x, spawn.pos.y, spawn.pos.z),
      yaw: restored?.yaw ?? spawn.yaw,
      pitch: 0,
      hp: restored?.hp ?? MAX_HEALTH,
      dead: restored?.dead ?? false,
      kills: restored?.kills ?? 0,
      deaths: restored?.deaths ?? 0,
      epoch: 1,
      respawnAt: restored?.dead ? (restored.respawnAt ?? now + RESPAWN_DELAY_MS) : null,
      lastInputAt: now,
      lastSeen: now,
      airRise: 0,
      hoverMs: 0,
      windowDist: 0,
      windowStart: now,
      shotTokens: SHOT_BURST,
      shotRefillAt: now,
      msgCount: 0,
      msgWindowAt: now,
    };

    this.players.set(id, player);
    this.bySocket.set(ws, player);

    this.send(ws, {
      type: "welcome",
      id,
      token,
      color: player.color,
      spawn: [player.pos.x, player.pos.y, player.pos.z],
      yaw: player.yaw,
      e: player.epoch,
      hp: player.dead ? 0 : player.hp,
      roster: this.roster(),
    });
    this.broadcastRoster();
  }

  private dropSocket(ws: WebSocket): void {
    this.pending.delete(ws);
    const player = this.bySocket.get(ws);
    if (player) {
      this.bySocket.delete(ws);
      this.players.delete(player.id);
      // Hold score + combat state so a quick reconnect (same token) restores it.
      this.grace.set(player.token, {
        kills: player.kills,
        deaths: player.deaths,
        color: player.color,
        hp: player.hp,
        dead: player.dead,
        respawnAt: player.respawnAt,
        pos: player.pos,
        yaw: player.yaw,
        expiresAt: Date.now() + RECONNECT_GRACE_MS,
      });
      this.broadcastRoster();
    }
    this.stopTickingIfIdle();
  }

  // --- Input & movement validation ----------------------------------------------

  private handleInput(player: Player, msg: InputMsg): void {
    if (player.dead || msg.e !== player.epoch) return;

    const now = Date.now();
    // dt is clamped: a client that went silent did not move while silent (the
    // client only simulates while its loop runs), so a long gap must never
    // grant a huge teleport allowance.
    const dtMs = Math.min(Math.max(now - player.lastInputAt, 15), 400);
    const dt = dtMs / 1000;
    player.lastInputAt = now;

    // View angles update regardless of whether the position is accepted.
    player.yaw = msg.yaw;
    player.pitch = clampPitch(msg.pitch);

    const next = vec3(msg.p[0], msg.p[1], msg.p[2]);

    // Clamp into the arena volume.
    const lim = ARENA_HALF - PLAYER_RADIUS;
    next.x = Math.min(lim, Math.max(-lim, next.x));
    next.z = Math.min(lim, Math.max(-lim, next.z));
    next.y = Math.min(MAX_Y, Math.max(0, next.y));

    // Per-message speed check: reject teleports, keep the last valid position.
    const dx = next.x - player.pos.x;
    const dz = next.z - player.pos.z;
    const horizDist = Math.hypot(dx, dz);
    const maxDist = MOVE_SPEED * SPEED_TOLERANCE * dt + SPEED_SLACK;
    if (horizDist > maxDist) return;

    // Sliding-window budget: the per-message slack must not be farmable by
    // raising the input rate, so total movement per wall-clock second is capped.
    if (now - player.windowStart > MOVE_WINDOW_MS) {
      player.windowStart = now;
      player.windowDist = 0;
    }
    if (player.windowDist + horizDist > MOVE_WINDOW_DIST) return;

    // Reject positions embedded in geometry (no hiding inside walls).
    const box = playerAABB(next);
    box.min.x += EMBED_EPSILON;
    box.min.y += EMBED_EPSILON;
    box.min.z += EMBED_EPSILON;
    box.max.x -= EMBED_EPSILON;
    box.max.y -= EMBED_EPSILON;
    box.max.z -= EMBED_EPSILON;
    for (const solid of SOLIDS) {
      if (aabbIntersects(box, solid)) return;
    }

    // Vertical plausibility: altitude gain since last ground contact is capped
    // at the jump apex (anti-fly), and an airborne player must keep descending
    // once past the apex dwell (anti-hover).
    const support = this.supportUnder(next);
    if (next.y <= support + 0.02) {
      player.airRise = 0;
      player.hoverMs = 0;
    } else {
      const rise = next.y - player.pos.y;
      if (rise > 0) {
        if (player.airRise + rise > MAX_AIR_RISE) return;
        player.airRise += rise;
      }
      if (next.y > player.pos.y - 0.03) {
        player.hoverMs += dtMs;
        if (player.hoverMs > MAX_HOVER_MS) return;
      } else {
        player.hoverMs = 0;
      }
    }

    player.windowDist += horizDist;
    player.pos = next;
  }

  /** Highest surface (floor or solid top) at-or-below the player's feet. */
  private supportUnder(pos: Vec3): number {
    const box = playerAABB(pos);
    let support = 0;
    for (const solid of SOLIDS) {
      if (
        box.min.x < solid.max.x &&
        box.max.x > solid.min.x &&
        box.min.z < solid.max.z &&
        box.max.z > solid.min.z &&
        solid.max.y <= pos.y + 0.1 &&
        solid.max.y > support
      ) {
        support = solid.max.y;
      }
    }
    return support;
  }

  // --- Combat ---------------------------------------------------------------------

  private handleShoot(player: Player, msg: ShootMsg): void {
    if (player.dead || msg.e !== player.epoch) return;

    // Fire-rate token bucket: sustained rate is capped at exactly one shot per
    // cooldown; a burst allowance of 0.5 absorbs network jitter.
    const now = Date.now();
    player.shotTokens = Math.min(
      SHOT_BURST,
      player.shotTokens + (now - player.shotRefillAt) / WEAPON_COOLDOWN_MS,
    );
    player.shotRefillAt = now;
    if (player.shotTokens < 1) return;
    player.shotTokens -= 1;

    // The claimed muzzle position must agree with where the server thinks the
    // shooter's eye is (small tolerance for in-flight movement), and must be
    // reachable from that eye without crossing geometry — otherwise the origin
    // tolerance becomes a "poke the muzzle through the wall" exploit.
    const origin = vec3(msg.o[0], msg.o[1], msg.o[2]);
    const eye = vec3(player.pos.x, player.pos.y + EYE_HEIGHT, player.pos.z);
    const horiz = Math.hypot(origin.x - eye.x, origin.z - eye.z);
    if (horiz > SHOT_ORIGIN_TOLERANCE || Math.abs(origin.y - eye.y) > SHOT_ORIGIN_DY) return;
    const offset = vec3(origin.x - eye.x, origin.y - eye.y, origin.z - eye.z);
    const offsetLen = Math.sqrt(distSq(origin, eye));
    if (offsetLen > 0.01) {
      const blocked = rayAABBs(eye, normalize(offset), SOLIDS, offsetLen);
      if (blocked !== null && blocked < offsetLen - 0.01) return;
    }

    const dir = normalize(vec3(msg.d[0], msg.d[1], msg.d[2]));

    // Authoritative raycast: nearest of (world geometry, floor, other players).
    let endT = rayAABBs(origin, dir, SOLIDS, WEAPON_RANGE) ?? WEAPON_RANGE;
    if (dir.y < -1e-6) {
      const tFloor = -origin.y / dir.y;
      if (tFloor > 0 && tFloor < endT) endT = tFloor;
    }

    let victim: Player | null = null;
    let victimT = endT;
    for (const other of this.players.values()) {
      if (other.id === player.id || other.dead) continue;
      const t = rayAABB(origin, dir, playerAABB(other.pos), WEAPON_RANGE);
      if (t !== null && t < victimT) {
        victimT = t;
        victim = other;
      }
    }

    this.broadcast({
      type: "shot",
      id: player.id,
      o: [origin.x, origin.y, origin.z],
      d: [dir.x, dir.y, dir.z],
      t: victim ? victimT : endT,
      hitId: victim?.id,
    });

    if (!victim) return;

    victim.hp -= WEAPON_DAMAGE;
    this.broadcast({ type: "hit", id: victim.id, by: player.id, dmg: WEAPON_DAMAGE, hp: Math.max(0, victim.hp) });

    if (victim.hp <= 0) {
      victim.hp = 0;
      victim.dead = true;
      victim.deaths += 1;
      victim.respawnAt = now + RESPAWN_DELAY_MS;
      player.kills += 1;
      this.broadcast({ type: "death", id: victim.id, by: player.id });
      this.broadcastRoster();
    }
  }

  // --- Tick loop ---------------------------------------------------------------------

  private ensureTicking(): void {
    if (this.tickTimer === null) {
      this.tickTimer = setInterval(() => this.tick(), TICK_MS);
    }
  }

  private stopTickingIfIdle(): void {
    if (this.players.size === 0 && this.pending.size === 0 && this.tickTimer !== null) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  private tick(): void {
    const now = Date.now();

    // Respawns.
    for (const p of this.players.values()) {
      if (p.dead && p.respawnAt !== null && now >= p.respawnAt) {
        const spawn = this.pickSpawn();
        p.pos = vec3(spawn.pos.x, spawn.pos.y, spawn.pos.z);
        p.yaw = spawn.yaw;
        p.pitch = 0;
        p.hp = MAX_HEALTH;
        p.dead = false;
        p.respawnAt = null;
        p.epoch += 1;
        p.lastInputAt = now;
        p.airRise = 0;
        p.hoverMs = 0;
        p.windowDist = 0;
        p.windowStart = now;
        this.broadcast({
          type: "spawn",
          id: p.id,
          p: [spawn.pos.x, spawn.pos.y, spawn.pos.z],
          yaw: spawn.yaw,
          e: p.epoch,
          hp: p.hp,
        });
      }
    }

    // Idle sockets (client pings every 5s, so 30s of silence means it is gone).
    for (const p of [...this.players.values()]) {
      if (now - p.lastSeen > IDLE_TIMEOUT_MS) {
        const ws = p.ws;
        this.dropSocket(ws); // also broadcasts the roster
        try {
          ws.close(CLOSE_IDLE, "idle timeout");
        } catch {
          // already closed
        }
      }
    }

    // Sockets that connected but never sent a join.
    for (const [ws, since] of this.pending) {
      if (now - since > JOIN_TIMEOUT_MS) {
        this.pending.delete(ws);
        try {
          ws.close(CLOSE_REJOIN, "join timeout");
        } catch {
          // already closed
        }
      }
    }

    // Expired reconnect-grace scores.
    for (const [token, entry] of this.grace) {
      if (now > entry.expiresAt) this.grace.delete(token);
    }

    this.stopTickingIfIdle();

    // Consolidated state snapshot to everyone.
    if (this.players.size > 0) {
      const players: PlayerSnapshot[] = [...this.players.values()].map((p) => ({
        id: p.id,
        p: [round2(p.pos.x), round2(p.pos.y), round2(p.pos.z)],
        yaw: round3(p.yaw),
        pitch: round3(p.pitch),
        hp: p.hp,
        dead: p.dead,
      }));
      this.broadcast({ type: "state", players });
    }
  }

  // --- Helpers ---------------------------------------------------------------------------

  private floodCheck(player: Player): boolean {
    const now = Date.now();
    if (now - player.msgWindowAt > 1000) {
      player.msgWindowAt = now;
      player.msgCount = 0;
    }
    player.msgCount += 1;
    if (player.msgCount > MAX_MSGS_PER_SEC) {
      const ws = player.ws;
      this.dropSocket(ws);
      try {
        ws.close(CLOSE_REJOIN, "message flood");
      } catch {
        // already closed
      }
      return true;
    }
    return false;
  }

  private pickSpawn(): SpawnPoint {
    const enemies = [...this.players.values()].filter((p) => !p.dead);
    if (enemies.length === 0) {
      return SPAWN_POINTS[Math.floor(Math.random() * SPAWN_POINTS.length)];
    }
    const scored = SPAWN_POINTS.map((sp) => ({
      sp,
      d: Math.min(...enemies.map((e) => distSq(sp.pos, e.pos))),
    }));
    scored.sort((a, b) => b.d - a.d);
    const top = scored.slice(0, 3);
    return top[Math.floor(Math.random() * top.length)].sp;
  }

  private pickColor(): number {
    const used = new Map<number, number>();
    for (const p of this.players.values()) used.set(p.color, (used.get(p.color) ?? 0) + 1);
    let best: number = PLAYER_COLORS[0];
    let bestCount = Infinity;
    for (const c of PLAYER_COLORS) {
      const n = used.get(c) ?? 0;
      if (n < bestCount) {
        bestCount = n;
        best = c;
      }
    }
    return best;
  }

  private roster(): PlayerScore[] {
    return [...this.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      color: p.color,
      kills: p.kills,
      deaths: p.deaths,
    }));
  }

  private broadcastRoster(): void {
    this.broadcast({ type: "roster", players: this.roster() });
  }

  private broadcast(msg: ServerMsg): void {
    const data = JSON.stringify(msg);
    for (const p of this.players.values()) {
      try {
        p.ws.send(data);
      } catch {
        // Socket is mid-close; the close handler will clean it up.
      }
    }
  }

  private send(ws: WebSocket, msg: ServerMsg): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // Socket is mid-close.
    }
  }
}

function sanitizeName(raw: string): string {
  const cleaned = raw
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 16)
    .trim();
  return cleaned.length > 0 ? cleaned : "Player";
}

function clampPitch(pitch: number): number {
  return Math.min(1.55, Math.max(-1.55, pitch));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
