// The authoritative game server: one Durable Object instance holds the entire
// room — roster, positions, health, weapons, pickups, and combat resolution.
// Clients stream position/rotation at ~20Hz and *claim* shots; the server
// re-runs every shot as raycasts against its own view of the world, so client
// hit claims are never trusted.
//
// Rooms named "solo-*" are practice arenas: the server spawns AI bots that
// roam the waypoint graph, pick up weapons, and fight back.
//
// WebSockets use the Hibernation API (ctx.acceptWebSocket + webSocketMessage
// handlers). While players are connected a 20Hz tick interval keeps the object
// hot; if the object is ever restarted (deploy, eviction), surviving sockets
// are closed with CLOSE_REJOIN and clients transparently reconnect.

import { DurableObject } from "cloudflare:workers";

import type { Env } from "./index";

import {
  DEFAULT_WEAPON,
  EYE_HEIGHT,
  GRAVITY,
  HEALTH_PACK_HP,
  IDLE_TIMEOUT_MS,
  ITEM_RESPAWN_MS,
  JUMP_VELOCITY,
  MAX_HEALTH,
  MAX_PLAYERS,
  MOVE_SPEED,
  MOVE_WINDOW_DIST,
  MOVE_WINDOW_MS,
  PICKUP_DY,
  PICKUP_RADIUS,
  PLAYER_COLORS,
  PLAYER_RADIUS,
  PROTOCOL_VERSION,
  RECONNECT_GRACE_MS,
  RESPAWN_DELAY_MS,
  SHOT_ORIGIN_DY,
  SHOT_ORIGIN_TOLERANCE,
  SOLO_BOT_COUNT,
  SOLO_ROOM_PREFIX,
  SPEED_SLACK,
  SPEED_TOLERANCE,
  TICK_MS,
  WEAPONS,
} from "../shared/constants";
import type { WeaponId } from "../shared/constants";
import { ARENA_HALF, ITEM_SPAWNS, SOLIDS, SPAWN_POINTS, WAYPOINTS } from "../shared/map";
import type { SpawnPoint, Vec3 } from "../shared/map";
import {
  distSq,
  normalize,
  perturbDir,
  playerAABB,
  rayAABB,
  rayAABBs,
  vec3,
} from "../shared/math";
import {
  CLOSE_FULL,
  CLOSE_IDLE,
  CLOSE_OUTDATED,
  CLOSE_REJOIN,
  CLOSE_REPLACED,
  parseClientMsg,
  type InputMsg,
  type ItemState,
  type JoinMsg,
  type PlayerScore,
  type PlayerSnapshot,
  type ServerMsg,
  type ShootMsg,
  type ShotRay,
  type StateMsg,
} from "../shared/protocol";
import {
  BOT_ENGAGE_RANGE,
  BOT_NAMES,
  BOT_REACTION_MS,
  BOT_SCAN_MS,
  BOT_SPEED,
  clampToArena,
  embedded,
  findPath,
  nearestNode,
  newBrain,
  stepGround,
  type BotBrain,
} from "./bots";

interface Player {
  id: string;
  token: string;
  name: string;
  color: number;
  /** null for bots. */
  ws: WebSocket | null;
  bot: BotBrain | null;
  pos: Vec3;
  yaw: number;
  pitch: number;
  hp: number;
  dead: boolean;
  kills: number;
  deaths: number;
  weapon: WeaponId;
  /** Remaining ammo per picked-up weapon (the default weapon is infinite). */
  ammo: Partial<Record<WeaponId, number>>;
  /** Incremented on every (re)spawn; inputs carrying a stale epoch are dropped. */
  epoch: number;
  respawnAt: number | null;
  lastInputAt: number;
  lastSeen: number;
  /** Earliest time the next shot is accepted (per current weapon's cooldown). */
  nextShotAt: number;
  /** Cumulative altitude gained since last touching a surface (anti-fly). */
  airRise: number;
  /** Milliseconds spent airborne without descending (anti-hover). */
  hoverMs: number;
  /** Sliding-window cumulative horizontal movement (anti-speedhack). */
  windowDist: number;
  windowStart: number;
  /** Simple flood guard. */
  msgCount: number;
  msgWindowAt: number;
}

// Combat state is preserved across a reconnect so closing the socket is never
// an escape hatch: no combat-log healing, no respawn-delay skipping, no
// teleport-to-a-fresh-spawn while being chased. (Weapon pickups are dropped.)
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

interface ItemSlot {
  avail: boolean;
  respawnAt: number;
}

interface Nade {
  id: number;
  by: string;
  pos: Vec3;
  vel: Vec3;
  explodeAt: number;
}

const NADE_RADIUS = 0.12;
const NADE_BOUNCE = 0.45;
const NADE_FRICTION = 0.75;
const NADE_UP_BIAS = 3.0; // m/s added to the throw's vertical velocity

const MAX_MSGS_PER_SEC = 120;
const JOIN_TIMEOUT_MS = 10_000;
const MAX_PENDING = 16;
const MAX_Y = 12;
/** Max altitude gain without touching a surface: jump apex plus slack. */
const MAX_AIR_RISE = (JUMP_VELOCITY * JUMP_VELOCITY) / (2 * GRAVITY) + 0.35;
/** Max ms airborne without descending (a real jump apex dwell is well under this). */
const MAX_HOVER_MS = 700;
/** Cooldown jitter allowance: sustained fire rate is capped at ~1.06x nominal. */
const COOLDOWN_TOLERANCE = 0.94;

export class GameRoom extends DurableObject<Env> {
  private players = new Map<string, Player>();
  private bySocket = new Map<WebSocket, Player>();
  private pending = new Map<WebSocket, number>(); // socket -> connect time, awaiting join
  private grace = new Map<string, GraceEntry>(); // token -> preserved score/state
  private items: ItemSlot[] = ITEM_SPAWNS.map(() => ({ avail: true, respawnAt: 0 }));
  private nades: Nade[] = [];
  private nadeSeq = 1;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private botsSpawned = false;

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
      const humans = [...this.players.values()].filter((p) => p.ws !== null).length;
      return Response.json({ players: humans, max: MAX_PLAYERS });
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

    this.ensureBots();

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
      if (existing && existing.ws !== null) {
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
        // Pickups are dropped on any reconnect (the client resets its inventory
        // on welcome; the grace path does the same — the flows must agree).
        existing.weapon = DEFAULT_WEAPON;
        existing.ammo = {};
        this.bySocket.set(ws, existing);
        this.send(ws, {
          type: "welcome",
          id: existing.id,
          token: existing.token,
          color: existing.color,
          spawn: [existing.pos.x, existing.pos.y, existing.pos.z],
          yaw: existing.yaw,
          e: existing.epoch,
          hp: existing.dead ? 0 : existing.hp,
          roster: this.roster(),
          items: this.itemStates(),
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

    const id = this.newId();
    const token = msg.token && restored ? msg.token : crypto.randomUUID();
    const spawn = this.pickSpawn();

    const player: Player = {
      id,
      token,
      name,
      color: restored?.color ?? this.pickColor(),
      ws,
      bot: null,
      pos: restored
        ? vec3(restored.pos.x, restored.pos.y, restored.pos.z)
        : vec3(spawn.pos.x, spawn.pos.y, spawn.pos.z),
      yaw: restored?.yaw ?? spawn.yaw,
      pitch: 0,
      hp: restored?.hp ?? MAX_HEALTH,
      dead: restored?.dead ?? false,
      kills: restored?.kills ?? 0,
      deaths: restored?.deaths ?? 0,
      weapon: DEFAULT_WEAPON,
      ammo: {},
      epoch: 1,
      respawnAt: restored?.dead ? (restored.respawnAt ?? now + RESPAWN_DELAY_MS) : null,
      lastInputAt: now,
      lastSeen: now,
      nextShotAt: 0,
      airRise: 0,
      hoverMs: 0,
      windowDist: 0,
      windowStart: now,
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
      items: this.itemStates(),
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

    // Reject positions embedded in geometry (no hiding inside walls), and
    // sweep the whole segment: a low input rate inflates dt (and therefore the
    // per-message allowance) enough to hop THROUGH thin cover if only the
    // endpoint were tested.
    if (embedded(next.x, next.y, next.z)) return;
    const sweepSteps = Math.ceil(horizDist / 0.3);
    for (let s = 1; s < sweepSteps; s++) {
      const f = s / sweepSteps;
      if (
        embedded(
          player.pos.x + dx * f,
          player.pos.y + (next.y - player.pos.y) * f,
          player.pos.z + dz * f,
        )
      ) {
        return;
      }
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
    this.checkPickups(player, now);
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

    const now = Date.now();
    const def = WEAPONS[msg.w];

    // Ownership/ammo: the default weapon is always available, pickups need ammo.
    if (def.ammo !== null && (player.ammo[msg.w] ?? 0) <= 0) return;
    if (now < player.nextShotAt) return;

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

    player.nextShotAt = now + def.cooldownMs * COOLDOWN_TOLERANCE;
    if (def.ammo !== null) {
      player.ammo[msg.w] = (player.ammo[msg.w] ?? 1) - 1;
    }
    player.weapon = msg.w;

    const dir = normalize(vec3(msg.d[0], msg.d[1], msg.d[2]));
    if (def.projectile) {
      this.spawnGrenade(player, origin, dir, now);
    } else {
      this.resolveShot(player, origin, dir, msg.w, now);
    }
  }

  // --- Grenades --------------------------------------------------------------------

  private spawnGrenade(shooter: Player, origin: Vec3, dir: Vec3, now: number): void {
    const proj = WEAPONS.frag.projectile;
    if (!proj) return;
    this.nades.push({
      id: this.nadeSeq++,
      by: shooter.id,
      pos: vec3(origin.x, origin.y, origin.z),
      vel: vec3(dir.x * proj.speed, dir.y * proj.speed + NADE_UP_BIAS, dir.z * proj.speed),
      explodeAt: now + proj.fuseMs,
    });
  }

  private simulateNades(now: number): void {
    if (this.nades.length === 0) return;
    const SUBSTEPS = 2;
    const dt = TICK_MS / 1000 / SUBSTEPS;
    const lim = ARENA_HALF - NADE_RADIUS;

    for (let i = this.nades.length - 1; i >= 0; i--) {
      const nade = this.nades[i];
      if (now >= nade.explodeAt) {
        this.nades.splice(i, 1);
        this.explode(nade, now);
        continue;
      }
      for (let s = 0; s < SUBSTEPS; s++) {
        nade.vel.y -= GRAVITY * dt;
        nade.pos.x += nade.vel.x * dt;
        nade.pos.y += nade.vel.y * dt;
        nade.pos.z += nade.vel.z * dt;

        // Floor and outer walls.
        if (nade.pos.y < NADE_RADIUS) {
          nade.pos.y = NADE_RADIUS;
          nade.vel.y = Math.abs(nade.vel.y) > 1.2 ? -nade.vel.y * NADE_BOUNCE : 0;
          nade.vel.x *= NADE_FRICTION;
          nade.vel.z *= NADE_FRICTION;
        }
        if (Math.abs(nade.pos.x) > lim) {
          nade.pos.x = Math.sign(nade.pos.x) * lim;
          nade.vel.x = -nade.vel.x * NADE_BOUNCE;
        }
        if (Math.abs(nade.pos.z) > lim) {
          nade.pos.z = Math.sign(nade.pos.z) * lim;
          nade.vel.z = -nade.vel.z * NADE_BOUNCE;
        }

        // Solid AABBs (expanded by the grenade radius): push out along the
        // shallowest axis and reflect that velocity component.
        for (const solid of SOLIDS) {
          const minX = solid.min.x - NADE_RADIUS;
          const maxX = solid.max.x + NADE_RADIUS;
          const minY = solid.min.y - NADE_RADIUS;
          const maxY = solid.max.y + NADE_RADIUS;
          const minZ = solid.min.z - NADE_RADIUS;
          const maxZ = solid.max.z + NADE_RADIUS;
          const p = nade.pos;
          if (p.x <= minX || p.x >= maxX || p.y <= minY || p.y >= maxY || p.z <= minZ || p.z >= maxZ) {
            continue;
          }
          const pushXNeg = p.x - minX;
          const pushXPos = maxX - p.x;
          const pushYNeg = p.y - minY;
          const pushYPos = maxY - p.y;
          const pushZNeg = p.z - minZ;
          const pushZPos = maxZ - p.z;
          const minPush = Math.min(pushXNeg, pushXPos, pushYNeg, pushYPos, pushZNeg, pushZPos);
          if (minPush === pushXNeg || minPush === pushXPos) {
            p.x = minPush === pushXNeg ? minX : maxX;
            nade.vel.x = -nade.vel.x * NADE_BOUNCE;
          } else if (minPush === pushYNeg || minPush === pushYPos) {
            p.y = minPush === pushYNeg ? minY : maxY;
            nade.vel.y = minPush === pushYPos && Math.abs(nade.vel.y) <= 1.2 ? 0 : -nade.vel.y * NADE_BOUNCE;
            nade.vel.x *= NADE_FRICTION;
            nade.vel.z *= NADE_FRICTION;
          } else {
            p.z = minPush === pushZNeg ? minZ : maxZ;
            nade.vel.z = -nade.vel.z * NADE_BOUNCE;
          }
        }
      }
    }
  }

  private explode(nade: Nade, now: number): void {
    this.broadcast({ type: "boom", p: [round2(nade.pos.x), round2(nade.pos.y), round2(nade.pos.z)], by: nade.by });
    const def = WEAPONS.frag;
    const radius = def.projectile?.radius ?? 6;
    const shooter = this.players.get(nade.by) ?? null;

    let killed = false;
    for (const victim of [...this.players.values()]) {
      if (victim.dead) continue;
      const chest = vec3(victim.pos.x, victim.pos.y + 0.9, victim.pos.z);
      const d = Math.sqrt(distSq(nade.pos, chest));
      if (d > radius) continue;
      // Walls shield the blast.
      if (d > 0.01) {
        const dir = normalize(vec3(chest.x - nade.pos.x, chest.y - nade.pos.y, chest.z - nade.pos.z));
        if (rayAABBs(nade.pos, dir, SOLIDS, d - 0.05) !== null) continue;
      }
      const dmg = Math.round(def.damage * (1 - d / radius));
      if (dmg <= 0) continue;
      if (this.applyDamage(victim, shooter, dmg, nade.by, now)) killed = true;
    }
    if (killed) this.broadcastRoster();
  }

  /** Authoritative hitscan: raycast every pellet, apply damage, handle kills. */
  private resolveShot(shooter: Player, origin: Vec3, dir: Vec3, w: WeaponId, now: number): void {
    const def = WEAPONS[w];
    const rays: ShotRay[] = [];
    const damage = new Map<Player, number>();

    for (let i = 0; i < def.pellets; i++) {
      const d = def.pellets > 1 ? perturbDir(dir, def.spread) : dir;

      let endT = rayAABBs(origin, d, SOLIDS, def.range) ?? def.range;
      if (d.y < -1e-6) {
        const tFloor = -origin.y / d.y;
        if (tFloor > 0 && tFloor < endT) endT = tFloor;
      }

      let victim: Player | null = null;
      let victimT = endT;
      for (const other of this.players.values()) {
        if (other.id === shooter.id || other.dead) continue;
        const t = rayAABB(origin, d, playerAABB(other.pos), def.range);
        if (t !== null && t < victimT) {
          victimT = t;
          victim = other;
        }
      }

      rays.push({
        d: [round3(d.x), round3(d.y), round3(d.z)],
        t: round2(victim ? victimT : endT),
        hitId: victim?.id,
      });
      if (victim) damage.set(victim, (damage.get(victim) ?? 0) + def.damage);
    }

    this.broadcast({
      type: "shot",
      id: shooter.id,
      w,
      o: [round2(origin.x), round2(origin.y), round2(origin.z)],
      rays,
    });

    let killed = false;
    for (const [victim, dmg] of damage) {
      if (this.applyDamage(victim, shooter, dmg, shooter.id, now)) killed = true;
    }
    if (killed) this.broadcastRoster();
  }

  /** Damage + death/credit bookkeeping. Returns true if the victim died. */
  private applyDamage(
    victim: Player,
    shooter: Player | null,
    dmg: number,
    byId: string,
    now: number,
  ): boolean {
    victim.hp -= dmg;
    this.broadcast({ type: "hit", id: victim.id, by: byId, dmg, hp: Math.max(0, victim.hp) });
    if (victim.hp > 0 || victim.dead) return false;
    victim.hp = 0;
    victim.dead = true;
    victim.deaths += 1;
    victim.respawnAt = now + RESPAWN_DELAY_MS;
    victim.weapon = DEFAULT_WEAPON;
    victim.ammo = {};
    // Self-frags count as a death but never as a kill.
    if (shooter && shooter.id !== victim.id) shooter.kills += 1;
    this.broadcast({ type: "death", id: victim.id, by: byId });
    return true;
  }

  // --- Weapon pickups ----------------------------------------------------------------

  private itemStates(): ItemState[] {
    return this.items.map((slot, i) => ({ id: ITEM_SPAWNS[i].id, avail: slot.avail }));
  }

  private checkPickups(player: Player, now: number): void {
    if (player.dead) return;
    for (let i = 0; i < this.items.length; i++) {
      const slot = this.items[i];
      if (!slot.avail) continue;
      const spawn = ITEM_SPAWNS[i];
      const dxz = Math.hypot(player.pos.x - spawn.pos.x, player.pos.z - spawn.pos.z);
      const dy = Math.abs(spawn.pos.y - (player.pos.y + 0.9));
      if (dxz > PICKUP_RADIUS || dy > PICKUP_DY) continue;

      if (spawn.kind === "health") {
        // Medkits are only consumed when actually hurt.
        if (player.hp >= MAX_HEALTH) continue;
        slot.avail = false;
        slot.respawnAt = now + ITEM_RESPAWN_MS;
        player.hp = Math.min(MAX_HEALTH, player.hp + HEALTH_PACK_HP);
        this.broadcast({ type: "item", id: spawn.id, avail: false });
        this.send(player.ws, { type: "heal", hp: player.hp });
        continue;
      }

      const weapon = spawn.weapon ?? DEFAULT_WEAPON;
      slot.avail = false;
      slot.respawnAt = now + ITEM_RESPAWN_MS;
      const def = WEAPONS[weapon];
      player.ammo[weapon] = def.ammo ?? 0;
      player.weapon = weapon;
      this.broadcast({ type: "item", id: spawn.id, avail: false });
      this.send(player.ws, { type: "pickup", w: weapon, ammo: def.ammo ?? 0 });
    }
  }

  // --- Practice bots --------------------------------------------------------------------

  private ensureBots(): void {
    if (this.botsSpawned || !this.ctx.id.name?.startsWith(SOLO_ROOM_PREFIX)) return;
    this.botsSpawned = true;
    const now = Date.now();
    for (let i = 0; i < SOLO_BOT_COUNT; i++) {
      const id = this.newId();
      const spawn = this.pickSpawn();
      const bot: Player = {
        id,
        token: `bot-${id}`,
        name: BOT_NAMES[i % BOT_NAMES.length],
        color: this.pickColor(),
        ws: null,
        bot: newBrain(),
        pos: vec3(spawn.pos.x, spawn.pos.y, spawn.pos.z),
        yaw: spawn.yaw,
        pitch: 0,
        hp: MAX_HEALTH,
        dead: false,
        kills: 0,
        deaths: 0,
        weapon: DEFAULT_WEAPON,
        ammo: {},
        epoch: 1,
        respawnAt: null,
        lastInputAt: now,
        lastSeen: now,
        nextShotAt: now + 1500,
        airRise: 0,
        hoverMs: 0,
        windowDist: 0,
        windowStart: now,
        msgCount: 0,
        msgWindowAt: now,
      };
      this.players.set(id, bot);
    }
  }

  private updateBots(now: number): void {
    const dt = TICK_MS / 1000;
    for (const bot of this.players.values()) {
      const brain = bot.bot;
      if (!brain || bot.dead) continue;

      // Target acquisition on a slow scan cadence.
      if (now >= brain.scanAt) {
        brain.scanAt = now + BOT_SCAN_MS;
        const prev = brain.targetId;
        brain.targetId = this.scanTarget(bot);
        if (brain.targetId && brain.targetId !== prev) {
          brain.reactAt = now + BOT_REACTION_MS + Math.random() * 250;
        }
      }

      const target = brain.targetId ? this.players.get(brain.targetId) : undefined;
      const engaged = target && !target.dead && this.canSee(bot, target) ? target : undefined;

      // Movement: strafe around a visible target, otherwise roam the waypoints.
      let mx = 0;
      let mz = 0;
      if (engaged) {
        const tx = engaged.pos.x - bot.pos.x;
        const tz = engaged.pos.z - bot.pos.z;
        const dist = Math.hypot(tx, tz) || 1;
        const fx = tx / dist;
        const fz = tz / dist;
        if (now >= brain.strafeUntil) {
          brain.strafeDir = Math.random() < 0.5 ? -1 : 1;
          brain.strafeUntil = now + 700 + Math.random() * 900;
        }
        const ideal = WEAPONS[bot.weapon].pellets > 1 ? 8 : 16;
        const closeIn = dist > ideal ? 0.7 : dist < ideal * 0.5 ? -0.6 : 0;
        mx = fz * brain.strafeDir + fx * closeIn;
        mz = -fx * brain.strafeDir + fz * closeIn;
        bot.yaw = Math.atan2(-fx, -fz);
        const dyAim = engaged.pos.y + 0.9 - (bot.pos.y + EYE_HEIGHT);
        bot.pitch = clampPitch(Math.atan2(dyAim, dist));
      } else {
        if (brain.path.length === 0 || brain.pathIdx >= brain.path.length || now >= brain.repathAt) {
          const goal =
            target && !target.dead
              ? nearestNode(target.pos)
              : Math.floor(Math.random() * WAYPOINTS.length);
          brain.path = findPath(nearestNode(bot.pos), goal);
          brain.pathIdx = 0;
          brain.repathAt = now + 9000;
        }
        if (brain.pathIdx < brain.path.length) {
          const node = WAYPOINTS[brain.path[brain.pathIdx]];
          const dx = node.x - bot.pos.x;
          const dz = node.z - bot.pos.z;
          const d = Math.hypot(dx, dz);
          if (d < 0.9) {
            brain.pathIdx += 1;
          } else {
            mx = dx / d;
            mz = dz / d;
            bot.yaw = Math.atan2(-mx, -mz);
            bot.pitch = 0;
          }
        }
      }

      const mlen = Math.hypot(mx, mz);
      if (mlen > 0.01) {
        const step = (BOT_SPEED * dt) / mlen;
        this.tryMoveBot(bot, brain, bot.pos.x + mx * step, bot.pos.z + mz * step);
      }
      this.checkPickups(bot, now);

      // Shooting: human-ish reaction delay, aim error grows with distance.
      if (engaged && now >= brain.reactAt && now >= bot.nextShotAt) {
        if (WEAPONS[bot.weapon].ammo !== null && (bot.ammo[bot.weapon] ?? 0) <= 0) {
          bot.weapon = DEFAULT_WEAPON;
        }
        const eyePos = vec3(bot.pos.x, bot.pos.y + EYE_HEIGHT, bot.pos.z);
        const chest = vec3(engaged.pos.x, engaged.pos.y + 0.9, engaged.pos.z);
        const dist = Math.sqrt(distSq(eyePos, chest));
        // Grenades are for mid-range lobs only — never frag yourself point-blank.
        if (WEAPONS[bot.weapon].projectile && (dist < 9 || dist > 24)) {
          bot.weapon = DEFAULT_WEAPON;
        }
        const def = WEAPONS[bot.weapon];
        const aim = perturbDir(
          normalize(vec3(chest.x - eyePos.x, chest.y - eyePos.y, chest.z - eyePos.z)),
          0.02 + dist * 0.0011,
        );
        if (def.ammo !== null) bot.ammo[bot.weapon] = (bot.ammo[bot.weapon] ?? 1) - 1;
        bot.nextShotAt = now + def.cooldownMs * (1.35 + Math.random() * 0.5);
        if (def.projectile) {
          this.spawnGrenade(bot, eyePos, aim, now);
        } else {
          this.resolveShot(bot, eyePos, aim, bot.weapon, now);
        }
      }
    }
  }

  private tryMoveBot(bot: Player, brain: BotBrain, nx: number, nz: number): void {
    const next = vec3(nx, bot.pos.y, nz);
    clampToArena(next, ARENA_HALF);
    const ny = stepGround(next.x, next.z, bot.pos.y);
    if (!embedded(next.x, ny, next.z)) {
      bot.pos = vec3(next.x, ny, next.z);
      return;
    }
    const nyX = stepGround(next.x, bot.pos.z, bot.pos.y);
    if (!embedded(next.x, nyX, bot.pos.z)) {
      bot.pos = vec3(next.x, nyX, bot.pos.z);
      return;
    }
    const nyZ = stepGround(bot.pos.x, next.z, bot.pos.y);
    if (!embedded(bot.pos.x, nyZ, next.z)) {
      bot.pos = vec3(bot.pos.x, nyZ, next.z);
      return;
    }
    // Fully stuck: force a strafe flip and a fresh path next tick.
    brain.strafeUntil = 0;
    brain.repathAt = 0;
  }

  private scanTarget(bot: Player): string | null {
    let best: Player | null = null;
    let bestD = BOT_ENGAGE_RANGE * BOT_ENGAGE_RANGE;
    for (const other of this.players.values()) {
      if (other.id === bot.id || other.dead) continue;
      const d = distSq(bot.pos, other.pos);
      if (d < bestD && this.canSee(bot, other)) {
        bestD = d;
        best = other;
      }
    }
    return best?.id ?? null;
  }

  private canSee(a: Player, b: Player): boolean {
    const eye = vec3(a.pos.x, a.pos.y + EYE_HEIGHT, a.pos.z);
    const chest = vec3(b.pos.x, b.pos.y + 0.9, b.pos.z);
    const dist = Math.sqrt(distSq(eye, chest));
    if (dist < 0.01) return true;
    const dir = normalize(vec3(chest.x - eye.x, chest.y - eye.y, chest.z - eye.z));
    return rayAABBs(eye, dir, SOLIDS, dist - 0.05) === null;
  }

  // --- Tick loop ---------------------------------------------------------------------

  private ensureTicking(): void {
    if (this.tickTimer === null) {
      this.tickTimer = setInterval(() => this.tick(), TICK_MS);
    }
  }

  private stopTickingIfIdle(): void {
    // Pending sockets count: someone is mid-join and must not find an emptied room.
    const humans =
      this.pending.size > 0 || [...this.players.values()].some((p) => p.ws !== null);
    if (!humans) {
      // No one is watching: clear bots so the room can go fully idle.
      for (const p of [...this.players.values()]) {
        if (p.ws === null) this.players.delete(p.id);
      }
      this.botsSpawned = false;
    }
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
        if (p.bot) {
          // Fresh brain: no instant zero-reaction revenge shot, no stale path.
          p.bot = newBrain();
          p.nextShotAt = now + 1500;
        }
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
      if (p.ws !== null && now - p.lastSeen > IDLE_TIMEOUT_MS) {
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

    // Weapon pickups respawn.
    for (let i = 0; i < this.items.length; i++) {
      const slot = this.items[i];
      if (!slot.avail && now >= slot.respawnAt) {
        slot.avail = true;
        this.broadcast({ type: "item", id: ITEM_SPAWNS[i].id, avail: true });
      }
    }

    this.updateBots(now);
    this.simulateNades(now);
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
        w: p.weapon,
      }));
      const state: StateMsg = { type: "state", players };
      if (this.nades.length > 0) {
        state.nades = this.nades.map((n) => ({
          id: n.id,
          p: [round2(n.pos.x), round2(n.pos.y), round2(n.pos.z)],
        }));
      }
      this.broadcast(state);
    }
  }

  // --- Helpers ---------------------------------------------------------------------------

  private newId(): string {
    let id = crypto.randomUUID().slice(0, 8);
    while (this.players.has(id)) id = crypto.randomUUID().slice(0, 8);
    return id;
  }

  private floodCheck(player: Player): boolean {
    const now = Date.now();
    if (now - player.msgWindowAt > 1000) {
      player.msgWindowAt = now;
      player.msgCount = 0;
    }
    player.msgCount += 1;
    if (player.msgCount > MAX_MSGS_PER_SEC) {
      const ws = player.ws;
      if (ws !== null) {
        this.dropSocket(ws);
        try {
          ws.close(CLOSE_REJOIN, "message flood");
        } catch {
          // already closed
        }
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
      if (p.ws === null) continue;
      try {
        p.ws.send(data);
      } catch {
        // Socket is mid-close; the close handler will clean it up.
      }
    }
  }

  private send(ws: WebSocket | null, msg: ServerMsg): void {
    if (ws === null) return;
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
