// Gameplay tuning shared by client and server. The server is authoritative for
// everything combat-related; the client mirrors these values for prediction and feel.

export const PROTOCOL_VERSION = 1;

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
export const WEAPON_NAME = "Riveter";
export const WEAPON_DAMAGE = 25;
export const WEAPON_COOLDOWN_MS = 240; // min ms between shots (server-enforced)
export const WEAPON_RANGE = 200; // metres
/** Max horizontal distance between the claimed shot origin and the server's eye. */
export const SHOT_ORIGIN_TOLERANCE = 1.5;
/** Max vertical divergence of the claimed shot origin (covers mid-jump latency). */
export const SHOT_ORIGIN_DY = 0.9;

export const RESPAWN_DELAY_MS = 3000;

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
