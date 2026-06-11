// Gameplay tuning shared by client and server. The server is authoritative for
// everything combat-related; the client mirrors these values for prediction and feel.

export const PROTOCOL_VERSION = 3;

/** Maximum players in the room. Joins beyond this are rejected with a "full" message. */
export const MAX_PLAYERS = 10;

/** Server broadcast rate (consolidated state snapshots), in Hz. */
export const TICK_RATE = 20;
export const TICK_MS = 1000 / TICK_RATE;

/** Client input send rate, in Hz. */
export const INPUT_RATE = 20;
export const INPUT_MS = 1000 / INPUT_RATE;

/** How far in the past remote players are rendered, ms (interpolation buffer). */
export const INTERP_DELAY_MS = 120;

// --- Player physique -------------------------------------------------------
export const PLAYER_RADIUS = 0.4; // half-width of the player AABB
export const PLAYER_HEIGHT = 1.8;
export const EYE_HEIGHT = 1.6;

// --- Movement (client simulates, server sanity-checks) ---------------------
export const MOVE_SPEED = 9; // m/s on the ground
export const GROUND_ACCEL = 14; // 1/s exponential approach rate toward wish velocity
export const AIR_ACCEL = 3.5;
export const JUMP_VELOCITY = 7.2; // m/s
export const GRAVITY = 20; // m/s^2

/** Speed-hack tolerance: max distance between two inputs is speed * dt * this + slack. */
export const SPEED_TOLERANCE = 1.75;
export const SPEED_SLACK = 0.4; // metres of absolute slack per input (jitter, packet bursts)
/** Cumulative horizontal movement allowed per sliding 1s window (wall-clock). */
export const MOVE_WINDOW_MS = 1000;
export const MOVE_WINDOW_DIST = 14;

// --- Combat -----------------------------------------------------------------
export const MAX_HEALTH = 100;

/**
 * Energy shield over health: absorbs damage first, recharges after a few
 * seconds out of combat. Health underneath only heals via medkits.
 */
export const MAX_SHIELD = 50;
export const SHIELD_REGEN_DELAY_MS = 5000;
export const SHIELD_REGEN_PER_S = 30;
/** The overshield power-up charges the shield to this (no regen above MAX_SHIELD). */
export const OVERSHIELD = 100;

export type WeaponId = "riveter" | "scrapshot" | "arcwelder" | "frag" | "lance" | "smelter";

export interface ProjectileDef {
  /** Initial speed, m/s. */
  speed: number;
  fuseMs: number;
  /** Splash radius; damage falls off linearly to zero at this distance. */
  radius: number;
  /** Grenade-style arc + bounces (true) or straight flight (false). */
  gravity: boolean;
  /** Detonate on first contact (rockets) instead of bouncing until the fuse. */
  impact: boolean;
}

export interface WeaponDef {
  name: string;
  /** Damage per pellet (for projectiles: max splash damage at the centre). */
  damage: number;
  cooldownMs: number;
  range: number;
  pellets: number;
  /** Max cone half-angle for pellet scatter, radians. */
  spread: number;
  /** Ammo granted on pickup; null = infinite (the default weapon). */
  ammo: number | null;
  /** Tracer/beam color. */
  color: number;
  /** Set for thrown projectiles (grenades) instead of hitscan rays. */
  projectile?: ProjectileDef;
}

export const WEAPONS: Record<WeaponId, WeaponDef> = {
  riveter: {
    name: "Riveter",
    damage: 25,
    cooldownMs: 240,
    range: 200,
    pellets: 1,
    spread: 0,
    ammo: null,
    color: 0xffc070,
  },
  scrapshot: {
    name: "Scrapshot",
    damage: 12,
    cooldownMs: 900,
    range: 40,
    pellets: 7,
    spread: 0.085,
    ammo: 8,
    color: 0xffa030,
  },
  arcwelder: {
    name: "Arcwelder",
    damage: 70,
    cooldownMs: 1400,
    range: 200,
    pellets: 1,
    spread: 0,
    ammo: 5,
    color: 0x33ffd0,
  },
  frag: {
    name: "Frag Charge",
    damage: 80,
    cooldownMs: 900,
    range: 0,
    pellets: 1,
    spread: 0,
    ammo: 3,
    color: 0xff4455,
    projectile: { speed: 17, fuseMs: 2000, radius: 6, gravity: true, impact: false },
  },
  lance: {
    name: "Pyrelance",
    damage: 90,
    cooldownMs: 1200,
    range: 0,
    pellets: 1,
    spread: 0,
    ammo: 4,
    color: 0xff7722,
    projectile: { speed: 28, fuseMs: 6000, radius: 5, gravity: false, impact: true },
  },
  smelter: {
    name: "The Smelter",
    damage: 200,
    cooldownMs: 2500,
    range: 200,
    pellets: 1,
    spread: 0,
    ammo: 2,
    color: 0xffffff,
  },
};

export const DEFAULT_WEAPON: WeaponId = "riveter";
export const WEAPON_IDS = Object.keys(WEAPONS) as WeaponId[];

/** Weapon pickups respawn this long after being taken. */
export const ITEM_RESPAWN_MS = 20_000;
/** Horizontal reach to grab a pickup (also allows reaching over the shop counter). */
export const PICKUP_RADIUS = 1.5;
/**
 * Vertical reach (item height vs chest height). Tight enough that an item on
 * a deck cannot be grabbed by a player standing underneath it.
 */
export const PICKUP_DY = 1.2;
/** Health restored by a medkit pickup (grabbed only when below max health). */
export const HEALTH_PACK_HP = 50;

// --- Power-ups -----------------------------------------------------------------
export const OVERDRIVE_MS = 20_000; // x2 damage
export const BOOTS_MS = 20_000; // x1.4 move speed
export const BOOTS_MULT = 1.4;
/** Buff bitmask flags carried in player snapshots. */
export const BUFF_OVERDRIVE = 1;
export const BUFF_BOOTS = 2;

// --- Environment ------------------------------------------------------------------
/** Lava pools: damage per second while standing in one (bypasses nothing — shields first). */
export const LAVA_DPS = 10;
/** Display names for non-player killers (DeathMsg.by). */
export const ENV_KILLERS: Record<string, string> = {
  "env:lava": "THE SLAG",
  "m:fiend": "A SCRAP FIEND",
  "m:drone": "A WELDER DRONE",
  "m:warden": "THE FOUNDRY WARDEN",
};

/** Display names for monster kinds (killfeed victims, boss bar). */
export const MONSTER_NAMES: Record<string, string> = {
  fiend: "SCRAP FIEND",
  drone: "WELDER DRONE",
  warden: "FOUNDRY WARDEN",
};

/** Jump pads launch with this vertical velocity (apex ≈ 2.8m). */
export const JUMP_PAD_VY = 10.6;
export const TELEPORT_COOLDOWN_MS = 1500;

// --- Match structure -----------------------------------------------------------------
/** First to this many points (frags + zone bonuses) wins the match. */
export const FRAG_LIMIT = 20;
/** Podium time between matches. */
export const INTERMISSION_MS = 12_000;
/** Hold the bastion roof alone this long for +1 score. */
export const ZONE_HOLD_MS = 10_000;

/** Max horizontal distance between the claimed shot origin and the server's eye. */
export const SHOT_ORIGIN_TOLERANCE = 1.5;
/** Max vertical divergence of the claimed shot origin (covers mid-jump latency). */
export const SHOT_ORIGIN_DY = 0.9;

export const RESPAWN_DELAY_MS = 3000;

// --- Practice mode (solo rooms get server-side bots) ---------------------------
export const SOLO_ROOM_PREFIX = "solo-";
export const SOLO_BOT_COUNT = 3;

/** The shared co-op horde arena (one room, like the main arena). */
export const HORDE_ROOM = "horde-arena";

// --- Connection hygiene ------------------------------------------------------
/** Client sends a ping at this interval; server drops sockets silent for IDLE_TIMEOUT_MS. */
export const PING_INTERVAL_MS = 5000;
export const IDLE_TIMEOUT_MS = 30_000;
/** A disconnected player's score is held this long for reconnect. */
export const RECONNECT_GRACE_MS = 60_000;

/** Distinct player colors (hex), assigned server-side on join. */
export const PLAYER_COLORS = [
  0xff5533, // magma orange
  0x33ddff, // cyan
  0xffcc22, // amber
  0x66ff44, // acid green
  0xff44aa, // hot pink
  0x9966ff, // violet
  0x00ffc8, // teal
  0xff8855, // rust
  0x88aaff, // steel blue
  0xddff66, // sulfur
] as const;
