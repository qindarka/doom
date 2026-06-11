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
  BOOTS_MS,
  BOOTS_MULT,
  BUFF_BOOTS,
  BUFF_OVERDRIVE,
  DEFAULT_WEAPON,
  EYE_HEIGHT,
  FRAG_LIMIT,
  GRAVITY,
  INTERMISSION_MS,
  HEALTH_PACK_HP,
  IDLE_TIMEOUT_MS,
  ITEM_RESPAWN_MS,
  JUMP_VELOCITY,
  LAVA_DPS,
  MAX_HEALTH,
  MAX_PLAYERS,
  MAX_SHIELD,
  MOVE_SPEED,
  MOVE_WINDOW_DIST,
  MOVE_WINDOW_MS,
  OVERDRIVE_MS,
  OVERSHIELD,
  PICKUP_DY,
  PICKUP_RADIUS,
  PLAYER_COLORS,
  PLAYER_RADIUS,
  PROTOCOL_VERSION,
  RECONNECT_GRACE_MS,
  RESPAWN_DELAY_MS,
  SHIELD_REGEN_DELAY_MS,
  SHIELD_REGEN_PER_S,
  SHOT_ORIGIN_DY,
  SHOT_ORIGIN_TOLERANCE,
  SOLO_BOT_COUNT,
  SOLO_ROOM_PREFIX,
  SPEED_SLACK,
  SPEED_TOLERANCE,
  TELEPORT_COOLDOWN_MS,
  TICK_MS,
  WEAPONS,
  ZONE_HOLD_MS,
} from "../shared/constants";
import type { WeaponId } from "../shared/constants";
import {
  ARENA_HALF,
  ITEM_SPAWNS,
  JUMP_PADS,
  SOLIDS,
  SPAWN_POINTS,
  TELEPORTERS,
  WAYPOINTS,
  inHazard,
} from "../shared/map";
import type { AABB } from "../shared/map";
import { DOOR_ANIM_MS, DOOR_BOX, DOOR_OPEN_FOR_MS, elevatorBoxAt } from "../shared/dynamics";
import type { SpawnPoint, Vec3 } from "../shared/map";
import {
  aabbIntersects,
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
import {
  DRONE_BOLT_COOLDOWN_MS,
  FIEND_MELEE_COOLDOWN_MS,
  FIEND_MELEE_DMG,
  FIEND_MELEE_RANGE,
  HORDE_GAMEOVER_MS,
  MONSTER_DEFS,
  VENTS,
  WARDEN_FRAG_COOLDOWN_MS,
  WARDEN_SLAM_COOLDOWN_MS,
  WARDEN_SLAM_DMG,
  WARDEN_SLAM_RADIUS,
  WARDEN_TELEGRAPH_MS,
  WAVE_INTERMISSION_MS,
  WAVE_SPAWN_STAGGER_MS,
  wardenHp,
  waveQueue,
  type Monster,
  type MonsterKind,
} from "./monsters";
import { HORDE_ROOM } from "../shared/constants";

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
  shield: number;
  lastDamagedAt: number;
  dead: boolean;
  kills: number;
  deaths: number;
  /** Kills since last death (sprees) + multi-kill window tracking. */
  streak: number;
  multiAt: number;
  multiN: number;
  /** Buff expiries (server time, 0 = inactive). */
  odUntil: number;
  bootsUntil: number;
  /** Recently launched by a jump pad: relaxed vertical validation. */
  padUntil: number;
  /** Teleporter cooldown (prevents instant ping-pong). */
  tpUntil: number;
  lavaAcc: number;
  /** Standing on a teleporter pad (re-arms only after stepping off). */
  wasOnPad: boolean;
  /** Uninterrupted solo time on the bastion roof (control bonus). */
  zoneMs: number;
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
  shield: number;
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
  k: "f" | "r" | "b";
  dmg: number;
  radius: number;
  gravity: boolean;
  impact: boolean;
  pos: Vec3;
  vel: Vec3;
  explodeAt: number;
  bornAt: number;
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
  /** Server time the secret door opened (0 = closed). */
  private doorOpenedAt = 0;
  private matchLive = true;
  private matchResetAt = 0;
  // Horde mode (the shared co-op room only).
  private monsters = new Map<number, Monster>();
  private monsterSeq = 1;
  private waveN = 0;
  private waveActive = false;
  private spawnQueue: MonsterKind[] = [];
  private nextSpawnAt = 0;
  private nextWaveAt = 0;

  private get isHorde(): boolean {
    return this.ctx.id.name === HORDE_ROOM;
  }

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
          door: this.doorOpenedAt > 0,
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
      shield: restored?.shield ?? MAX_SHIELD,
      lastDamagedAt: 0,
      dead: restored?.dead ?? false,
      kills: restored?.kills ?? 0,
      deaths: restored?.deaths ?? 0,
      streak: 0,
      multiAt: 0,
      multiN: 0,
      odUntil: 0,
      bootsUntil: 0,
      padUntil: 0,
      tpUntil: 0,
      lavaAcc: 0,
      wasOnPad: false,
      zoneMs: 0,
      weapon: DEFAULT_WEAPON,
      ammo: {},
      epoch: 1,
      // Horde keeps the dead-until-wave-end null; refreshing is not a revive.
      respawnAt: restored?.dead
        ? this.isHorde
          ? restored.respawnAt
          : (restored.respawnAt ?? now + RESPAWN_DELAY_MS)
        : null,
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
      door: this.doorOpenedAt > 0,
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
        shield: player.shield,
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
    const speedMult = now < player.bootsUntil ? BOOTS_MULT : 1;
    const dx = next.x - player.pos.x;
    const dz = next.z - player.pos.z;
    const horizDist = Math.hypot(dx, dz);
    const maxDist = MOVE_SPEED * speedMult * SPEED_TOLERANCE * dt + SPEED_SLACK;
    if (horizDist > maxDist) return;

    // Sliding-window budget: the per-message slack must not be farmable by
    // raising the input rate, so total movement per wall-clock second is capped.
    if (now - player.windowStart > MOVE_WINDOW_MS) {
      player.windowStart = now;
      player.windowDist = 0;
    }
    if (player.windowDist + horizDist > MOVE_WINDOW_DIST * speedMult) return;

    // Standing on a jump pad arms a short window of relaxed vertical checks
    // (the launch rises well past the normal jump apex).
    if (next.y < 0.4) {
      for (const pad of JUMP_PADS) {
        if (Math.hypot(next.x - pad.pos.x, next.z - pad.pos.z) <= pad.radius + 0.3) {
          player.padUntil = now + 1300;
          break;
        }
      }
    }

    // Reject positions embedded in geometry (no hiding inside walls), and
    // sweep the whole segment: a low input rate inflates dt (and therefore the
    // per-message allowance) enough to hop THROUGH thin cover if only the
    // endpoint were tested.
    if (this.embeddedDyn(next.x, next.y, next.z, now)) return;
    const sweepSteps = Math.ceil(horizDist / 0.3);
    for (let s = 1; s < sweepSteps; s++) {
      const f = s / sweepSteps;
      if (
        this.embeddedDyn(
          player.pos.x + dx * f,
          player.pos.y + (next.y - player.pos.y) * f,
          player.pos.z + dz * f,
          now,
        )
      ) {
        return;
      }
    }

    // Vertical plausibility: altitude gain since last ground contact is capped
    // at the jump apex (anti-fly), and an airborne player must keep descending
    // once past the apex dwell (anti-hover). Jump pads widen both limits.
    const padBoosted = now < player.padUntil;
    const maxRise = padBoosted ? 3.4 : MAX_AIR_RISE;
    const maxHover = padBoosted ? 1100 : MAX_HOVER_MS;
    const support = this.supportUnder(next, now);
    if (next.y <= support + 0.02) {
      player.airRise = 0;
      player.hoverMs = 0;
    } else {
      const rise = next.y - player.pos.y;
      if (rise > 0) {
        if (player.airRise + rise > maxRise) return;
        player.airRise += rise;
      }
      if (next.y > player.pos.y - 0.03) {
        player.hoverMs += dtMs;
        if (player.hoverMs > maxHover) return;
      } else {
        // Descent earns proportional credit — never a free full reset, or a
        // 3cm "sawtooth dip" would defeat the hover cap indefinitely.
        const descent = player.pos.y - next.y;
        player.hoverMs = Math.max(0, player.hoverMs - descent * 2000);
      }
    }

    player.windowDist += horizDist;
    player.pos = next;
    this.checkPickups(player, now);
    this.checkTeleport(player, now);
  }

  /** Step on a teleporter pad → flash across the arena (shared by bots). */
  private checkTeleport(p: Player, now: number): boolean {
    // Re-arm only after stepping OFF the destination pad: arriving plants you
    // on a live pad, and without this an idle player ping-pongs forever.
    const onPad =
      p.pos.y <= 0.4 &&
      TELEPORTERS.some(
        (pad) => Math.hypot(p.pos.x - pad.pos.x, p.pos.z - pad.pos.z) <= pad.radius,
      );
    if (!onPad) {
      p.wasOnPad = false;
      return false;
    }
    if (p.wasOnPad || p.dead || now < p.tpUntil) return false;
    for (const pad of TELEPORTERS) {
      if (Math.hypot(p.pos.x - pad.pos.x, p.pos.z - pad.pos.z) > pad.radius) continue;
      const dest = TELEPORTERS[pad.to];
      p.pos = vec3(dest.pos.x, 0, dest.pos.z);
      const len = Math.hypot(dest.pos.x, dest.pos.z) || 1;
      p.yaw = Math.atan2(dest.pos.x / len, dest.pos.z / len); // face the centre
      p.epoch += 1;
      p.tpUntil = now + TELEPORT_COOLDOWN_MS;
      p.wasOnPad = true; // standing on the destination pad
      p.lastInputAt = now;
      p.airRise = 0;
      p.hoverMs = 0;
      p.windowDist = 0;
      p.windowStart = now;
      this.broadcast({
        type: "spawn",
        id: p.id,
        p: [p.pos.x, p.pos.y, p.pos.z],
        yaw: round3(p.yaw),
        e: p.epoch,
        hp: p.hp,
        tp: true,
      });
      return true;
    }
    return false;
  }

  /** All collision boxes right now: static map + door (when shut) + elevator. */
  private solidsNow(now: number): AABB[] {
    const list = [...SOLIDS, elevatorBoxAt(now)];
    if (!this.doorPassable(now)) list.push(DOOR_BOX);
    return list;
  }

  /** The door blocks until fully open, and again once it reseals. */
  private doorPassable(now: number): boolean {
    return (
      this.doorOpenedAt > 0 &&
      now >= this.doorOpenedAt + DOOR_ANIM_MS &&
      now < this.doorOpenedAt + DOOR_OPEN_FOR_MS
    );
  }

  private openDoor(now: number): void {
    if (this.doorOpenedAt !== 0) return;
    this.doorOpenedAt = now;
    this.broadcast({ type: "door", open: true });
  }

  /** Dynamic-geometry-aware embed test (bots' static `embedded` plus door/elevator). */
  private embeddedDyn(x: number, y: number, z: number, now: number): boolean {
    if (embedded(x, y, z)) return true;
    const box = playerAABB(vec3(x, y, z));
    box.min.x += 0.05;
    box.min.y += 0.05;
    box.min.z += 0.05;
    box.max.x -= 0.05;
    box.max.y -= 0.05;
    box.max.z -= 0.05;
    if (!this.doorPassable(now) && aabbIntersects(box, DOOR_BOX)) return true;
    // The elevator gets a generous riding tolerance: the client computes the
    // platform from an estimated clock, so a rider's feet legitimately sit up
    // to ~half a metre "inside" the server's view of a moving platform.
    const elev = elevatorBoxAt(now);
    return aabbIntersects(box, elev) && y < elev.max.y - 0.55;
  }

  /** Highest surface (floor or solid top) at-or-below the player's feet. */
  private supportUnder(pos: Vec3, now: number): number {
    const box = playerAABB(pos);
    let support = 0;
    for (const solid of this.solidsNow(now)) {
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
    // Riding tolerance: count the elevator as support even when its top is a
    // little above the claimed feet (clock-estimate divergence on the climb).
    const elev = elevatorBoxAt(now);
    if (
      box.min.x < elev.max.x &&
      box.max.x > elev.min.x &&
      box.min.z < elev.max.z &&
      box.max.z > elev.min.z &&
      elev.max.y <= pos.y + 0.55 &&
      elev.max.y > support
    ) {
      support = elev.max.y;
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
      const blocked = rayAABBs(eye, normalize(offset), this.solidsNow(now), offsetLen);
      if (blocked !== null && blocked < offsetLen - 0.01) return;
    }

    player.nextShotAt = now + def.cooldownMs * COOLDOWN_TOLERANCE;
    if (def.ammo !== null) {
      player.ammo[msg.w] = (player.ammo[msg.w] ?? 1) - 1;
      // Authoritative ammo echo: the client decremented optimistically and
      // silently-dropped shots would otherwise desync the count forever.
      this.send(player.ws, { type: "ammo", w: msg.w, n: player.ammo[msg.w] ?? 0 });
    }
    player.weapon = msg.w;

    const dir = normalize(vec3(msg.d[0], msg.d[1], msg.d[2]));
    if (def.projectile) {
      this.spawnGrenade(player, origin, dir, msg.w, now);
    } else {
      this.resolveShot(player, origin, dir, msg.w, now);
    }
  }

  // --- Projectiles (grenades + rockets) ------------------------------------------

  private spawnGrenade(shooter: Player, origin: Vec3, dir: Vec3, w: WeaponId, now: number): void {
    const def = WEAPONS[w];
    const proj = def.projectile;
    if (!proj) return;
    this.nades.push({
      id: this.nadeSeq++,
      by: shooter.id,
      k: proj.gravity ? "f" : "r",
      dmg: def.damage,
      radius: proj.radius,
      gravity: proj.gravity,
      impact: proj.impact,
      pos: vec3(origin.x, origin.y, origin.z),
      vel: vec3(
        dir.x * proj.speed,
        dir.y * proj.speed + (proj.gravity ? NADE_UP_BIAS : 0),
        dir.z * proj.speed,
      ),
      explodeAt: now + proj.fuseMs,
      bornAt: now,
    });
  }

  private simulateNades(now: number): void {
    if (this.nades.length === 0) return;
    const SUBSTEPS = 2;
    const dt = TICK_MS / 1000 / SUBSTEPS;
    const lim = ARENA_HALF - NADE_RADIUS;

    for (let i = this.nades.length - 1; i >= 0; i--) {
      const nade = this.nades[i];
      const impact = nade.impact;
      let detonate = now >= nade.explodeAt;

      for (let s = 0; s < SUBSTEPS && !detonate; s++) {
        if (nade.gravity) nade.vel.y -= GRAVITY * dt;
        nade.pos.x += nade.vel.x * dt;
        nade.pos.y += nade.vel.y * dt;
        nade.pos.z += nade.vel.z * dt;

        // Floor and outer walls.
        if (nade.pos.y < NADE_RADIUS) {
          nade.pos.y = NADE_RADIUS;
          if (impact) {
            detonate = true;
            break;
          }
          nade.vel.y = Math.abs(nade.vel.y) > 1.2 ? -nade.vel.y * NADE_BOUNCE : 0;
          nade.vel.x *= NADE_FRICTION;
          nade.vel.z *= NADE_FRICTION;
        }
        if (Math.abs(nade.pos.x) > lim) {
          nade.pos.x = Math.sign(nade.pos.x) * lim;
          if (impact) {
            detonate = true;
            break;
          }
          nade.vel.x = -nade.vel.x * NADE_BOUNCE;
        }
        if (Math.abs(nade.pos.z) > lim) {
          nade.pos.z = Math.sign(nade.pos.z) * lim;
          if (impact) {
            detonate = true;
            break;
          }
          nade.vel.z = -nade.vel.z * NADE_BOUNCE;
        }

        // Solid AABBs (expanded by the projectile radius): push out along the
        // shallowest axis; rockets detonate, grenades reflect.
        for (const solid of this.solidsNow(now)) {
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
            if (impact) detonate = true;
            else nade.vel.x = -nade.vel.x * NADE_BOUNCE;
          } else if (minPush === pushYNeg || minPush === pushYPos) {
            p.y = minPush === pushYNeg ? minY : maxY;
            if (impact) {
              detonate = true;
            } else {
              nade.vel.y =
                minPush === pushYPos && Math.abs(nade.vel.y) <= 1.2 ? 0 : -nade.vel.y * NADE_BOUNCE;
              nade.vel.x *= NADE_FRICTION;
              nade.vel.z *= NADE_FRICTION;
            }
          } else {
            p.z = minPush === pushZNeg ? minZ : maxZ;
            if (impact) detonate = true;
            else nade.vel.z = -nade.vel.z * NADE_BOUNCE;
          }
          if (detonate) break;
        }

        // Rockets detonate on body contact (the owner is immune briefly so a
        // point-blank launch doesn't clip the muzzle).
        if (impact && !detonate) {
          for (const other of this.players.values()) {
            if (other.dead) continue;
            if (other.id === nade.by && now - nade.bornAt < 250) continue;
            const box = playerAABB(other.pos);
            if (
              nade.pos.x > box.min.x - NADE_RADIUS &&
              nade.pos.x < box.max.x + NADE_RADIUS &&
              nade.pos.y > box.min.y - NADE_RADIUS &&
              nade.pos.y < box.max.y + NADE_RADIUS &&
              nade.pos.z > box.min.z - NADE_RADIUS &&
              nade.pos.z < box.max.z + NADE_RADIUS
            ) {
              detonate = true;
              break;
            }
          }
        }
      }

      if (detonate) {
        this.nades.splice(i, 1);
        this.explode(nade, now);
      }
    }
  }

  private explode(nade: Nade, now: number): void {
    this.broadcast({ type: "boom", p: [round2(nade.pos.x), round2(nade.pos.y), round2(nade.pos.z)], by: nade.by });
    const radius = nade.radius;
    const shooter = this.players.get(nade.by) ?? null;
    const solids = this.solidsNow(now);

    // A blast near the secret door blows it open too.
    if (
      this.doorOpenedAt === 0 &&
      distSq(nade.pos, vec3(0, 1.05, -4.4)) < 16
    ) {
      this.openDoor(now);
    }

    let killed = false;
    for (const victim of [...this.players.values()]) {
      if (victim.dead) continue;
      const chest = vec3(victim.pos.x, victim.pos.y + 0.9, victim.pos.z);
      const d = Math.sqrt(distSq(nade.pos, chest));
      if (d > radius) continue;
      // Walls shield the blast.
      if (d > 0.01) {
        const dir = normalize(vec3(chest.x - nade.pos.x, chest.y - nade.pos.y, chest.z - nade.pos.z));
        if (rayAABBs(nade.pos, dir, solids, d - 0.05) !== null) continue;
      }
      const dmg = Math.round(nade.dmg * (1 - d / radius));
      if (dmg <= 0) continue;
      if (this.applyDamage(victim, shooter, dmg, nade.by, now)) killed = true;
    }
    if (killed) this.broadcastRoster();

    // Splash also wounds monsters — but only PLAYER ordnance (no friendly fire
    // among the horde: warden frags and drone bolts never hurt their own).
    if (!nade.by.startsWith("m:")) {
      for (const m of [...this.monsters.values()]) {
        const center = vec3(m.pos.x, m.pos.y + MONSTER_DEFS[m.kind].height / 2, m.pos.z);
        const d = Math.sqrt(distSq(nade.pos, center));
        if (d > radius) continue;
        if (d > 0.01) {
          const dir = normalize(
            vec3(center.x - nade.pos.x, center.y - nade.pos.y, center.z - nade.pos.z),
          );
          if (rayAABBs(nade.pos, dir, solids, d - 0.05) !== null) continue;
        }
        let dmg = Math.round(nade.dmg * (1 - d / radius));
        if (shooter && now < shooter.odUntil) dmg *= 2; // overdrive, like every other path
        if (dmg > 0) this.damageMonster(m, dmg, shooter, now);
      }
    }
  }

  /** Authoritative hitscan: raycast every pellet, apply damage, handle kills. */
  private resolveShot(shooter: Player, origin: Vec3, dir: Vec3, w: WeaponId, now: number): void {
    const def = WEAPONS[w];
    const rays: ShotRay[] = [];
    const damage = new Map<Player, number>();
    const solids = this.solidsNow(now);

    for (let i = 0; i < def.pellets; i++) {
      const d = def.pellets > 1 ? perturbDir(dir, def.spread) : dir;

      let endT = rayAABBs(origin, d, solids, def.range) ?? def.range;
      if (d.y < -1e-6) {
        const tFloor = -origin.y / d.y;
        if (tFloor > 0 && tFloor < endT) endT = tFloor;
      }

      // Shooting the sealed secret door slides it open.
      if (this.doorOpenedAt === 0) {
        const tDoor = rayAABB(origin, d, DOOR_BOX, def.range);
        if (tDoor !== null && tDoor <= endT + 0.05) this.openDoor(now);
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

      // Monsters are targets too (horde mode).
      let mVictim: Monster | null = null;
      for (const m of this.monsters.values()) {
        const t = rayAABB(origin, d, monsterAABB(m), def.range);
        if (t !== null && t < victimT) {
          victimT = t;
          victim = null;
          mVictim = m;
        }
      }

      rays.push({
        d: [round3(d.x), round3(d.y), round3(d.z)],
        t: round2(victim || mVictim ? victimT : endT),
        hitId: victim?.id,
      });
      if (victim) damage.set(victim, (damage.get(victim) ?? 0) + def.damage);
      if (mVictim) {
        const dmg = now < shooter.odUntil ? def.damage * 2 : def.damage;
        this.damageMonster(mVictim, dmg, shooter, now);
      }
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

  /** Damage + shield/death/credit/streak bookkeeping. Returns true on death. */
  private applyDamage(
    victim: Player,
    shooter: Player | null,
    dmg: number,
    byId: string,
    now: number,
  ): boolean {
    if (!this.matchLive) return false; // intermission: nothing hurts
    // Horde is co-op: humans cannot hurt each other (self-splash still stings).
    if (this.isHorde && shooter && shooter.id !== victim.id && !shooter.bot && !victim.bot) {
      return false;
    }
    if (shooter && now < shooter.odUntil) dmg *= 2;
    victim.lastDamagedAt = now;

    // Shields absorb first; the rest spills into health.
    let remaining = dmg;
    if (victim.shield > 0) {
      const absorbed = Math.min(victim.shield, remaining);
      victim.shield -= absorbed;
      remaining -= absorbed;
    }
    victim.hp -= remaining;
    this.broadcast({
      type: "hit",
      id: victim.id,
      by: byId,
      dmg,
      hp: Math.max(0, victim.hp),
      s: Math.round(victim.shield),
    });
    if (victim.hp > 0 || victim.dead) return false;

    victim.hp = 0;
    victim.shield = 0;
    victim.dead = true;
    victim.deaths += 1;
    // Horde: the fallen stay down until the wave is cleared.
    victim.respawnAt = this.isHorde && this.waveActive ? null : now + RESPAWN_DELAY_MS;
    victim.weapon = DEFAULT_WEAPON;
    victim.ammo = {};
    if (victim.streak >= 5) {
      this.broadcast({ type: "streak", id: victim.id, kind: "ended" });
    }
    victim.streak = 0;
    victim.multiN = 0;

    // Self-frags and environmental deaths count as a death but never a kill.
    if (shooter && shooter.id !== victim.id) {
      shooter.kills += 1;
      shooter.streak += 1;
      shooter.multiN = now - shooter.multiAt <= 4000 ? shooter.multiN + 1 : 1;
      shooter.multiAt = now;
      if (shooter.multiN >= 2) {
        const kind =
          shooter.multiN >= 5 ? "multi5" : (`multi${shooter.multiN}` as "multi2" | "multi3" | "multi4");
        this.broadcast({ type: "streak", id: shooter.id, kind });
      }
      if (shooter.streak === 3 || shooter.streak === 5 || shooter.streak === 8 || shooter.streak === 10) {
        this.broadcast({
          type: "streak",
          id: shooter.id,
          kind: `spree${shooter.streak}` as "spree3" | "spree5" | "spree8" | "spree10",
        });
      }
    }
    this.broadcast({ type: "death", id: victim.id, by: byId });
    if (shooter && shooter.id !== victim.id) this.checkWin(shooter, now);

    // Horde: when the last human falls, the run is over.
    if (this.isHorde && this.matchLive) {
      const anyAlive = [...this.players.values()].some((p) => p.ws !== null && !p.dead);
      if (!anyAlive) {
        this.matchLive = false;
        this.matchResetAt = now + HORDE_GAMEOVER_MS;
        this.broadcast({
          type: "hordeend",
          wave: this.waveN,
          roster: this.roster(),
          nextIn: HORDE_GAMEOVER_MS / 1000,
        });
      }
    }
    return true;
  }

  /** Frag limit reached → podium intermission, then a fresh match. */
  private checkWin(p: Player, now: number): void {
    if (this.isHorde) return; // horde runs end by wipe, not frag limit
    if (!this.matchLive || p.kills < FRAG_LIMIT) return;
    this.matchLive = false;
    this.matchResetAt = now + INTERMISSION_MS;
    this.broadcast({
      type: "matchend",
      winnerId: p.id,
      roster: this.roster(),
      nextIn: INTERMISSION_MS / 1000,
    });
  }

  private resetMatch(now: number): void {
    this.matchLive = true;
    this.nades = [];
    this.doorOpenedAt = 0;
    this.grace.clear(); // previous-match scores must not restore into this one
    this.monsters.clear();
    this.spawnQueue = [];
    this.waveN = 0;
    this.waveActive = false;
    this.nextWaveAt = 0;
    for (let i = 0; i < this.items.length; i++) {
      this.items[i] = { avail: true, respawnAt: 0 };
    }
    for (const p of this.players.values()) {
      p.kills = 0;
      p.deaths = 0;
      p.streak = 0;
      p.multiN = 0;
      p.zoneMs = 0;
      const spawn = this.pickSpawn();
      p.pos = vec3(spawn.pos.x, spawn.pos.y, spawn.pos.z);
      p.yaw = spawn.yaw;
      p.pitch = 0;
      p.hp = MAX_HEALTH;
      p.shield = MAX_SHIELD;
      p.lastDamagedAt = 0;
      p.dead = false;
      p.respawnAt = null;
      p.epoch += 1;
      p.lastInputAt = now;
      p.airRise = 0;
      p.hoverMs = 0;
      p.windowDist = 0;
      p.windowStart = now;
      p.odUntil = 0;
      p.bootsUntil = 0;
      p.padUntil = 0;
      p.tpUntil = 0;
      p.lavaAcc = 0;
      p.weapon = DEFAULT_WEAPON;
      p.ammo = {};
      if (p.bot) {
        p.bot = newBrain();
        p.nextShotAt = now + 1500;
      }
      this.broadcast({
        type: "spawn",
        id: p.id,
        p: [p.pos.x, p.pos.y, p.pos.z],
        yaw: p.yaw,
        e: p.epoch,
        hp: p.hp,
      });
    }
    this.broadcast({ type: "door", open: false });
    this.broadcast({ type: "matchstart", roster: this.roster(), items: this.itemStates() });
  }

  // --- Horde monsters --------------------------------------------------------------

  private damageMonster(m: Monster, dmg: number, shooter: Player | null, now: number): void {
    if (!this.matchLive || !this.monsters.has(m.id)) return;
    m.hp -= dmg;
    if (m.hp > 0) return;
    this.monsters.delete(m.id);
    this.broadcast({
      type: "mdeath",
      id: m.id,
      k: m.kind,
      by: shooter?.id ?? "",
      p: [round2(m.pos.x), round2(m.pos.y), round2(m.pos.z)],
    });
    if (shooter) {
      shooter.kills += 1;
      this.broadcastRoster();
    }
    this.broadcast({
      type: "wave",
      n: this.waveN,
      state: "active",
      left: this.monsters.size + this.spawnQueue.length,
    });
    void now;
  }

  private spawnMonster(kind: MonsterKind, now: number): void {
    // Emerge from the vent farthest from the nearest living human.
    const humans = [...this.players.values()].filter((p) => p.ws !== null && !p.dead);
    let vent = VENTS[Math.floor(Math.random() * VENTS.length)];
    if (humans.length > 0) {
      let best = -1;
      for (const v of VENTS) {
        const nearest = Math.min(
          ...humans.map((h) => Math.hypot(h.pos.x - v.x, h.pos.z - v.z)),
        );
        if (nearest > best) {
          best = nearest;
          vent = v;
        }
      }
    }
    const def = MONSTER_DEFS[kind];
    const y = def.altitude ?? stepGround(vent.x, vent.z, 0);
    this.monsters.set(this.monsterSeq, {
      id: this.monsterSeq++,
      kind,
      pos: vec3(vent.x, y, vent.z),
      yaw: 0,
      hp: kind === "warden" ? wardenHp(this.waveN) : def.hp,
      maxHp: kind === "warden" ? wardenHp(this.waveN) : def.hp,
      targetId: null,
      retargetAt: 0,
      path: [],
      pathIdx: 0,
      repathAt: 0,
      nextAttackAt: now + 1000,
      slamAt: 0,
      slamPos: null,
      nextFragAt: now + 4000,
    });
  }

  private spawnBolt(m: Monster, target: Player, now: number): void {
    const def = MONSTER_DEFS[m.kind];
    const origin = vec3(m.pos.x, m.pos.y + def.height * 0.6, m.pos.z);
    const chest = vec3(target.pos.x, target.pos.y + 0.9, target.pos.z);
    const aim = perturbDir(
      normalize(vec3(chest.x - origin.x, chest.y - origin.y, chest.z - origin.z)),
      0.035,
    );
    this.nades.push({
      id: this.nadeSeq++,
      by: "m:drone",
      k: "b",
      dmg: 14,
      radius: 1.5,
      gravity: false,
      impact: true,
      pos: origin,
      vel: vec3(aim.x * 13, aim.y * 13, aim.z * 13),
      explodeAt: now + 3000,
      bornAt: now,
    });
  }

  private updateMonsters(now: number): void {
    if (this.monsters.size === 0 || !this.matchLive) return;
    const dt = TICK_MS / 1000;

    for (const m of [...this.monsters.values()]) {
      const def = MONSTER_DEFS[m.kind];

      // Pending warden slam resolves regardless of anything else.
      if (m.kind === "warden" && m.slamAt > 0 && now >= m.slamAt && m.slamPos) {
        const at = m.slamPos;
        m.slamAt = 0;
        m.slamPos = null;
        for (const p of [...this.players.values()]) {
          if (p.dead) continue;
          const chest = vec3(p.pos.x, p.pos.y + 0.9, p.pos.z);
          const d = Math.sqrt(distSq(vec3(at.x, at.y + 0.5, at.z), chest));
          if (d > WARDEN_SLAM_RADIUS) continue;
          const dir = normalize(vec3(chest.x - at.x, chest.y - (at.y + 0.5), chest.z - at.z));
          if (d > 0.01 && rayAABBs(vec3(at.x, at.y + 0.5, at.z), dir, this.solidsNow(now), d - 0.05) !== null) {
            continue;
          }
          this.applyDamage(p, null, Math.round(WARDEN_SLAM_DMG * (1 - (d / WARDEN_SLAM_RADIUS) * 0.5)), "m:warden", now);
        }
      }

      // Acquire the nearest living human.
      if (now >= m.retargetAt) {
        m.retargetAt = now + 600;
        let best: Player | null = null;
        let bestD = Infinity;
        for (const p of this.players.values()) {
          if (p.ws === null || p.dead) continue;
          const d = distSq(m.pos, p.pos);
          if (d < bestD) {
            bestD = d;
            best = p;
          }
        }
        m.targetId = best?.id ?? null;
      }
      const target = m.targetId ? this.players.get(m.targetId) : undefined;
      if (!target || target.dead) continue;

      const dx = target.pos.x - m.pos.x;
      const dz = target.pos.z - m.pos.z;
      const dist = Math.hypot(dx, dz) || 1;
      m.yaw = Math.atan2(-dx / dist, -dz / dist);

      if (m.kind === "drone") {
        // Hover at altitude, hold mid range, pepper with bolts.
        const desired = dist > 13 ? 1 : dist < 7 ? -0.7 : 0;
        const strafe = Math.sin(now / 700 + m.id) * 0.5;
        const mx = (dx / dist) * desired + (dz / dist) * strafe;
        const mz = (dz / dist) * desired - (dx / dist) * strafe;
        const nx = m.pos.x + mx * def.speed * dt;
        const nz = m.pos.z + mz * def.speed * dt;
        const next = vec3(nx, def.altitude ?? 2.4, nz);
        clampToArena(next, ARENA_HALF);
        if (!this.droneBlocked(next, now)) {
          m.pos = next;
        }
        if (now >= m.nextAttackAt && this.monsterSees(m, target, now)) {
          m.nextAttackAt = now + DRONE_BOLT_COOLDOWN_MS;
          this.spawnBolt(m, target, now);
        }
        continue;
      }

      // Grounded kinds: steer directly when close+visible, else follow waypoints.
      let mx = 0;
      let mz = 0;
      if (dist < 22 && this.monsterSees(m, target, now)) {
        mx = dx / dist;
        mz = dz / dist;
        m.path = [];
      } else {
        if (m.path.length === 0 || m.pathIdx >= m.path.length || now >= m.repathAt) {
          m.path = findPath(nearestNode(m.pos), nearestNode(target.pos));
          m.pathIdx = 0;
          m.repathAt = now + 3000;
        }
        if (m.pathIdx < m.path.length) {
          const node = WAYPOINTS[m.path[m.pathIdx]];
          const ndx = node.x - m.pos.x;
          const ndz = node.z - m.pos.z;
          const nd = Math.hypot(ndx, ndz);
          if (nd < 1.0) {
            m.pathIdx += 1;
          } else {
            mx = ndx / nd;
            mz = ndz / nd;
          }
        } else {
          mx = dx / dist;
          mz = dz / dist;
        }
      }
      const mlen = Math.hypot(mx, mz);
      if (mlen > 0.01) {
        const step = (def.speed * dt) / mlen;
        this.tryMoveMonster(m, m.pos.x + mx * step, m.pos.z + mz * step);
      }

      if (m.kind === "fiend") {
        if (
          dist <= FIEND_MELEE_RANGE &&
          Math.abs(target.pos.y - m.pos.y) < 1.6 &&
          now >= m.nextAttackAt
        ) {
          m.nextAttackAt = now + FIEND_MELEE_COOLDOWN_MS;
          this.applyDamage(target, null, FIEND_MELEE_DMG, "m:fiend", now);
        }
      } else if (m.kind === "warden") {
        if (m.slamAt === 0 && dist < WARDEN_SLAM_RADIUS + 0.5 && now >= m.nextAttackAt) {
          m.slamAt = now + WARDEN_TELEGRAPH_MS;
          m.slamPos = vec3(m.pos.x, m.pos.y, m.pos.z);
          m.nextAttackAt = now + WARDEN_SLAM_COOLDOWN_MS;
          this.broadcast({
            type: "slam",
            p: [round2(m.pos.x), round2(m.pos.y), round2(m.pos.z)],
            at: m.slamAt,
          });
        } else if (
          dist >= 8 &&
          dist <= 22 &&
          now >= m.nextFragAt &&
          this.monsterSees(m, target, now)
        ) {
          m.nextFragAt = now + WARDEN_FRAG_COOLDOWN_MS;
          const origin = vec3(m.pos.x, m.pos.y + 2.0, m.pos.z);
          const chest = vec3(target.pos.x, target.pos.y + 0.9, target.pos.z);
          const aim = normalize(vec3(chest.x - origin.x, chest.y - origin.y + dist * 0.04, chest.z - origin.z));
          this.nades.push({
            id: this.nadeSeq++,
            by: "m:warden",
            k: "f",
            dmg: 60,
            radius: 5,
            gravity: true,
            impact: false,
            pos: origin,
            vel: vec3(aim.x * 17, aim.y * 17 + NADE_UP_BIAS, aim.z * 17),
            explodeAt: now + 2000,
            bornAt: now,
          });
        }
      }
    }
  }

  private tryMoveMonster(m: Monster, nx: number, nz: number): void {
    const next = vec3(nx, m.pos.y, nz);
    clampToArena(next, ARENA_HALF);
    const ny = stepGround(next.x, next.z, m.pos.y);
    if (!embedded(next.x, ny, next.z)) {
      m.pos = vec3(next.x, ny, next.z);
      return;
    }
    const nyX = stepGround(next.x, m.pos.z, m.pos.y);
    if (!embedded(next.x, nyX, m.pos.z)) {
      m.pos = vec3(next.x, nyX, m.pos.z);
      return;
    }
    const nyZ = stepGround(m.pos.x, next.z, m.pos.y);
    if (!embedded(m.pos.x, nyZ, next.z)) {
      m.pos = vec3(m.pos.x, nyZ, next.z);
      return;
    }
    m.repathAt = 0;
  }

  private droneBlocked(next: Vec3, now: number): boolean {
    const half = MONSTER_DEFS.drone.halfW;
    const box: AABB = {
      min: { x: next.x - half, y: next.y - half, z: next.z - half },
      max: { x: next.x + half, y: next.y + half, z: next.z + half },
    };
    for (const solid of this.solidsNow(now)) {
      if (aabbIntersects(box, solid)) return true;
    }
    return false;
  }

  private monsterSees(m: Monster, target: Player, now: number): boolean {
    const def = MONSTER_DEFS[m.kind];
    const eye = vec3(m.pos.x, m.pos.y + def.height * 0.7, m.pos.z);
    const chest = vec3(target.pos.x, target.pos.y + 0.9, target.pos.z);
    const dist = Math.sqrt(distSq(eye, chest));
    if (dist < 0.01) return true;
    const dir = normalize(vec3(chest.x - eye.x, chest.y - eye.y, chest.z - eye.z));
    return rayAABBs(eye, dir, this.solidsNow(now), dist - 0.05) === null;
  }

  /** The wave machine: staggered vent spawns, clears, revivals, next wave. */
  private updateWaves(now: number): void {
    if (!this.isHorde || !this.matchLive) return;
    const humansPresent = [...this.players.values()].some((p) => p.ws !== null);
    if (!humansPresent) return;

    // A wipe can also happen by disconnection or idle-kick of the last living
    // player — applyDamage alone would never notice, soft-locking the run.
    if (this.waveActive) {
      const anyAlive = [...this.players.values()].some((p) => p.ws !== null && !p.dead);
      if (!anyAlive) {
        this.matchLive = false;
        this.matchResetAt = now + HORDE_GAMEOVER_MS;
        this.broadcast({
          type: "hordeend",
          wave: this.waveN,
          roster: this.roster(),
          nextIn: HORDE_GAMEOVER_MS / 1000,
        });
        return;
      }
    }

    if (this.waveN === 0) {
      if (this.nextWaveAt === 0) {
        this.nextWaveAt = now + 5000;
        this.broadcast({ type: "wave", n: 1, state: "incoming", left: 0 });
      }
      if (now >= this.nextWaveAt) this.startWave(1, now);
      return;
    }

    // Staggered spawns from the vents.
    if (this.spawnQueue.length > 0 && now >= this.nextSpawnAt) {
      this.nextSpawnAt = now + WAVE_SPAWN_STAGGER_MS;
      const kind = this.spawnQueue.shift() as MonsterKind;
      this.spawnMonster(kind, now);
      this.broadcast({
        type: "wave",
        n: this.waveN,
        state: "active",
        left: this.monsters.size + this.spawnQueue.length,
      });
    }

    // Wave cleared: revive the fallen, breathe, go again.
    if (this.waveActive && this.spawnQueue.length === 0 && this.monsters.size === 0) {
      this.waveActive = false;
      this.nextWaveAt = now + WAVE_INTERMISSION_MS;
      this.broadcast({ type: "wave", n: this.waveN, state: "cleared", left: 0 });
      for (const p of this.players.values()) {
        if (p.dead && p.respawnAt === null) p.respawnAt = now; // next tick revives
      }
    }
    if (!this.waveActive && this.waveN > 0 && now >= this.nextWaveAt) {
      this.startWave(this.waveN + 1, now);
    }
  }

  private startWave(n: number, now: number): void {
    this.waveN = n;
    this.waveActive = true;
    this.spawnQueue = waveQueue(n);
    this.nextSpawnAt = now + 1500;
    this.broadcast({ type: "wave", n, state: "incoming", left: this.spawnQueue.length });
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
        slot.respawnAt = now + (spawn.respawnMs ?? ITEM_RESPAWN_MS);
        player.hp = Math.min(MAX_HEALTH, player.hp + HEALTH_PACK_HP);
        this.broadcast({ type: "item", id: spawn.id, avail: false });
        this.send(player.ws, { type: "heal", hp: player.hp });
        continue;
      }

      if (spawn.kind === "overdrive" || spawn.kind === "boots" || spawn.kind === "overshield") {
        slot.avail = false;
        slot.respawnAt = now + (spawn.respawnMs ?? ITEM_RESPAWN_MS);
        if (spawn.kind === "overdrive") {
          player.odUntil = now + OVERDRIVE_MS;
          this.send(player.ws, { type: "buff", k: "overdrive", ms: OVERDRIVE_MS });
        } else if (spawn.kind === "boots") {
          player.bootsUntil = now + BOOTS_MS;
          this.send(player.ws, { type: "buff", k: "boots", ms: BOOTS_MS });
        } else {
          player.shield = OVERSHIELD;
          this.send(player.ws, { type: "buff", k: "overshield", ms: 0 });
        }
        this.broadcast({ type: "item", id: spawn.id, avail: false });
        continue;
      }

      const weapon = spawn.weapon ?? DEFAULT_WEAPON;
      slot.avail = false;
      slot.respawnAt = now + (spawn.respawnMs ?? ITEM_RESPAWN_MS);
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
        shield: MAX_SHIELD,
        lastDamagedAt: 0,
        dead: false,
        kills: 0,
        deaths: 0,
        streak: 0,
        multiAt: 0,
        multiN: 0,
        odUntil: 0,
        bootsUntil: 0,
        padUntil: 0,
        tpUntil: 0,
        lavaAcc: 0,
        wasOnPad: false,
        zoneMs: 0,
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
      if (this.checkTeleport(bot, now)) {
        brain.path = [];
        brain.pathIdx = 0;
        brain.repathAt = 0;
      }

      // Shooting: human-ish reaction delay, aim error grows with distance.
      if (engaged && this.matchLive && now >= brain.reactAt && now >= bot.nextShotAt) {
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
          this.spawnGrenade(bot, eyePos, aim, bot.weapon, now);
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
    if (!embedded(next.x, ny, next.z) && !inHazard(next.x, ny, next.z)) {
      bot.pos = vec3(next.x, ny, next.z);
      return;
    }
    const nyX = stepGround(next.x, bot.pos.z, bot.pos.y);
    if (!embedded(next.x, nyX, bot.pos.z) && !inHazard(next.x, nyX, bot.pos.z)) {
      bot.pos = vec3(next.x, nyX, bot.pos.z);
      return;
    }
    const nyZ = stepGround(bot.pos.x, next.z, bot.pos.y);
    if (!embedded(bot.pos.x, nyZ, next.z) && !inHazard(bot.pos.x, nyZ, next.z)) {
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
    return rayAABBs(eye, dir, this.solidsNow(Date.now()), dist - 0.05) === null;
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
      // No one is watching: clear bots and the horde so the room can go idle.
      for (const p of [...this.players.values()]) {
        if (p.ws === null) this.players.delete(p.id);
      }
      this.botsSpawned = false;
      this.monsters.clear();
      this.spawnQueue = [];
      this.waveN = 0;
      this.waveActive = false;
      this.nextWaveAt = 0;
      this.matchLive = true;
    }
    if (this.players.size === 0 && this.pending.size === 0 && this.tickTimer !== null) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  private tick(): void {
    const now = Date.now();

    // Intermission over → fresh match.
    if (!this.matchLive && now >= this.matchResetAt && this.players.size > 0) {
      this.resetMatch(now);
    }

    // The secret door reseals (never while someone stands in the frame).
    if (this.doorOpenedAt > 0 && now >= this.doorOpenedAt + DOOR_OPEN_FOR_MS) {
      const margin: AABB = {
        min: { x: DOOR_BOX.min.x - 0.8, y: DOOR_BOX.min.y, z: DOOR_BOX.min.z - 0.8 },
        max: { x: DOOR_BOX.max.x + 0.8, y: DOOR_BOX.max.y, z: DOOR_BOX.max.z + 0.8 },
      };
      let blocked = false;
      for (const p of this.players.values()) {
        if (!p.dead && aabbIntersects(playerAABB(p.pos), margin)) {
          blocked = true;
          break;
        }
      }
      if (!blocked) {
        this.doorOpenedAt = 0;
        this.broadcast({ type: "door", open: false });
      }
    }

    this.updateWaves(now);
    this.updateMonsters(now);

    // Bastion control: hold the roof alone for ZONE_HOLD_MS → +1 score.
    if (this.matchLive && !this.isHorde) {
      let occupant: Player | null = null;
      let contested = false;
      for (const p of this.players.values()) {
        if (p.dead) continue;
        if (Math.abs(p.pos.x) <= 5 && Math.abs(p.pos.z) <= 5 && p.pos.y >= 2.3) {
          if (occupant) contested = true;
          else occupant = p;
        }
      }
      for (const p of this.players.values()) {
        if (p === occupant && !contested) {
          p.zoneMs += TICK_MS;
          if (p.zoneMs >= ZONE_HOLD_MS) {
            p.zoneMs = 0;
            p.kills += 1;
            this.broadcast({ type: "zone", id: p.id });
            this.broadcastRoster();
            this.checkWin(p, now);
          }
        } else {
          p.zoneMs = 0;
        }
      }
    }

    // Shield regeneration + lava damage.
    for (const p of [...this.players.values()]) {
      if (p.dead) continue;
      if (p.shield < MAX_SHIELD && now - p.lastDamagedAt >= SHIELD_REGEN_DELAY_MS) {
        p.shield = Math.min(MAX_SHIELD, p.shield + (SHIELD_REGEN_PER_S * TICK_MS) / 1000);
      }
      if (inHazard(p.pos.x, p.pos.y, p.pos.z)) {
        p.lavaAcc += TICK_MS;
        while (p.lavaAcc >= 500 && !p.dead) {
          p.lavaAcc -= 500;
          this.applyDamage(p, null, LAVA_DPS / 2, "env:lava", now);
        }
        if (p.dead) this.broadcastRoster();
      } else {
        p.lavaAcc = 0;
      }
    }

    // Respawns.
    for (const p of this.players.values()) {
      if (p.dead && p.respawnAt !== null && now >= p.respawnAt) {
        const spawn = this.pickSpawn();
        p.pos = vec3(spawn.pos.x, spawn.pos.y, spawn.pos.z);
        p.yaw = spawn.yaw;
        p.pitch = 0;
        p.hp = MAX_HEALTH;
        p.shield = MAX_SHIELD;
        p.lastDamagedAt = 0;
        p.dead = false;
        p.respawnAt = null;
        p.epoch += 1;
        p.lastInputAt = now;
        p.airRise = 0;
        p.hoverMs = 0;
        p.windowDist = 0;
        p.windowStart = now;
        p.odUntil = 0;
        p.bootsUntil = 0;
        p.padUntil = 0;
        p.tpUntil = 0;
        p.lavaAcc = 0;
        p.zoneMs = 0;
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

    // Pickups respawn (the Smelter's return is the client-side announce event).
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
        s: Math.round(p.shield),
        dead: p.dead,
        w: p.weapon,
        b: (now < p.odUntil ? BUFF_OVERDRIVE : 0) | (now < p.bootsUntil ? BUFF_BOOTS : 0),
      }));
      const state: StateMsg = { type: "state", t: now, players };
      if (this.nades.length > 0) {
        state.nades = this.nades.map((n) => ({
          id: n.id,
          k: n.k,
          p: [round2(n.pos.x), round2(n.pos.y), round2(n.pos.z)],
        }));
      }
      if (this.monsters.size > 0) {
        state.m = [...this.monsters.values()].map((m) => ({
          id: m.id,
          k: m.kind,
          p: [round2(m.pos.x), round2(m.pos.y), round2(m.pos.z)],
          yaw: round3(m.yaw),
          hp: Math.max(0, Math.round(m.hp)),
          mh: m.maxHp,
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

function monsterAABB(m: Monster): AABB {
  const def = MONSTER_DEFS[m.kind];
  const baseY = def.altitude !== undefined ? m.pos.y - def.height / 2 : m.pos.y;
  return {
    min: { x: m.pos.x - def.halfW, y: baseY, z: m.pos.z - def.halfW },
    max: { x: m.pos.x + def.halfW, y: baseY + def.height, z: m.pos.z + def.halfW },
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
