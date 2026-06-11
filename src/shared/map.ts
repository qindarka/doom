// The arena, defined as data so the client (rendering, collision) and the server
// (raycast hit validation, spawn points, bot navigation) are guaranteed to agree.
//
// Coordinates: Y is up, the floor is y = 0. The arena is a square centred on the
// origin, enclosed by four boundary walls. All solids are axis-aligned boxes;
// solids may float (decks, the shop roof, the jumbotron) — players walk both
// under and on top of them.

import type { WeaponId } from "./constants";

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface AABB {
  min: Vec3;
  max: Vec3;
}

export interface SpawnPoint {
  pos: Vec3; // feet position
  yaw: number; // radians; yaw 0 faces -Z, positive turns toward -X
}

/** Half the playable width — the inner faces of the boundary walls sit at ±ARENA_HALF. */
export const ARENA_HALF = 34;
export const WALL_HEIGHT = 6;
export const WALL_THICKNESS = 1;

function box(cx: number, cz: number, w: number, d: number, h: number, y0 = 0): AABB {
  return {
    min: { x: cx - w / 2, y: y0, z: cz - d / 2 },
    max: { x: cx + w / 2, y: y0 + h, z: cz + d / 2 },
  };
}

const A = ARENA_HALF;
const T = WALL_THICKNESS;

/** The four boundary walls (their inner faces sit exactly at ±ARENA_HALF). */
export const WALLS: AABB[] = [
  box(0, -(A + T / 2), 2 * (A + T), T, WALL_HEIGHT), // north (-Z)
  box(0, A + T / 2, 2 * (A + T), T, WALL_HEIGHT), // south (+Z)
  box(-(A + T / 2), 0, T, 2 * (A + T), WALL_HEIGHT), // west (-X)
  box(A + T / 2, 0, T, 2 * (A + T), WALL_HEIGHT), // east (+X)
];

export type ObstacleKind =
  | "monolith" // the bastion core
  | "pillar"
  | "barrier"
  | "crate"
  | "lowcrate"
  | "step"
  | "deck"
  | "counter"
  | "roof"
  | "screen";

export interface Obstacle extends AABB {
  kind: ObstacleKind;
}

function obs(kind: ObstacleKind, b: AABB): Obstacle {
  return { kind, min: b.min, max: b.max };
}

/**
 * Cover and structures. Jump apex is ~1.3m: 1m/1.2m crates are climbable, 2m+
 * is pure cover. The client auto-steps up to 0.55m, so stairs are walkable.
 */
export const OBSTACLES: Obstacle[] = [
  // --- Central bastion: hollow! A secret chamber hides inside, sealed by a
  // shootable door on the north face (the door itself is dynamic geometry —
  // see shared/dynamics.ts). Roof slab keeps the top walkable as before.
  obs("monolith", box(-4.4, 0, 1.2, 10, 2.5)), // west wall
  obs("monolith", box(4.4, 0, 1.2, 10, 2.5)), // east wall
  obs("monolith", box(0, 4.4, 7.6, 1.2, 2.5)), // south wall
  obs("monolith", box(-2.5, -4.4, 2.6, 1.2, 2.5)), // north wall, west of the door
  obs("monolith", box(2.5, -4.4, 2.6, 1.2, 2.5)), // north wall, east of the door
  obs("deck", box(0, 0, 10, 10, 0.4, 2.1)), // roof (top at 2.5, chamber headroom 2.1)
  // west stairs (0.5m risers, walk up via auto-step)
  obs("step", box(-5.6, 0, 1.2, 3, 2.0)),
  obs("step", box(-6.8, 0, 1.2, 3, 1.5)),
  obs("step", box(-8.0, 0, 1.2, 3, 1.0)),
  obs("step", box(-9.2, 0, 1.2, 3, 0.5)),
  // east stairs
  obs("step", box(5.6, 0, 1.2, 3, 2.0)),
  obs("step", box(6.8, 0, 1.2, 3, 1.5)),
  obs("step", box(8.0, 0, 1.2, 3, 1.0)),
  obs("step", box(9.2, 0, 1.2, 3, 0.5)),
  // jumbotron: pole on the deck + a two-faced screen slab high above it
  obs("pillar", box(0, 0, 0.7, 0.7, 1.9, 2.5)),
  obs("screen", box(0, 0, 7, 0.6, 2.4, 4.4)),

  // --- The Armory (shop) against the north wall ------------------------------
  obs("counter", box(0, -29.5, 9, 1.2, 1.1)),
  obs("pillar", box(-4.9, -31.5, 0.9, 5, 3.2)),
  obs("pillar", box(4.9, -31.5, 0.9, 5, 3.2)),
  obs("roof", box(0, -31.7, 11, 5, 0.5, 3.2)),

  // --- South sniper ledge, reached by the elevator (dynamic platform) ---------
  obs("deck", box(3.5, 31.4, 9, 4.2, 0.4, 4.0)),

  // --- Side decks: fight under them, jump up via the wall-side 1.2m crate ----
  obs("deck", box(-22, 0, 7, 11, 0.3, 1.9)),
  obs("lowcrate", box(-25.8, 7.2, 2, 2, 1.2)),
  obs("deck", box(22, 0, 7, 11, 0.3, 1.9)),
  obs("lowcrate", box(25.8, -7.2, 2, 2, 1.2)),

  // --- Mid-ring pillars --------------------------------------------------------
  obs("pillar", box(-14, -14, 1.8, 1.8, WALL_HEIGHT)),
  obs("pillar", box(14, -14, 1.8, 1.8, WALL_HEIGHT)),
  obs("pillar", box(-14, 14, 1.8, 1.8, WALL_HEIGHT)),
  obs("pillar", box(14, 14, 1.8, 1.8, WALL_HEIGHT)),

  // --- Mid-side barriers (chest-high lanes along each wall) -------------------
  obs("barrier", box(0, 25, 10, 1, 2.2)),
  obs("barrier", box(-25, 0, 1, 10, 2.2)),
  obs("barrier", box(25, 0, 1, 10, 2.2)),

  // --- Corner crate clusters ----------------------------------------------------
  obs("crate", box(27, 27, 2, 2, 2)),
  obs("lowcrate", box(24.5, 27.5, 1.4, 1.4, 1)),
  obs("crate", box(-27, 27, 2, 2, 2)),
  obs("lowcrate", box(-24.5, 27.5, 1.4, 1.4, 1)),
  obs("crate", box(27, -27, 2, 2, 2)),
  obs("lowcrate", box(24.5, -27.5, 1.4, 1.4, 1)),
  obs("crate", box(-27, -27, 2, 2, 2)),
  obs("lowcrate", box(-24.5, -27.5, 1.4, 1.4, 1)),

  // --- Scatter cover ---------------------------------------------------------------
  obs("crate", box(0, -9, 2.4, 2.4, 2)),
  obs("crate", box(0, 9, 2.4, 2.4, 2)),
  obs("lowcrate", box(-9, 11, 2.6, 2.6, 1)),
  obs("lowcrate", box(9, -11, 2.6, 2.6, 1)),
];

/** Everything a hitscan ray or a moving player can collide with. */
export const SOLIDS: AABB[] = [...WALLS, ...OBSTACLES];

// --- Weapon pickups ------------------------------------------------------------

// --- Environment features ---------------------------------------------------------

/**
 * Lava pools: shallow XZ regions that tick damage on anyone standing in them
 * (feet below max.y). Not solid — you can absolutely walk into one.
 */
export const HAZARDS: AABB[] = [
  { min: { x: -5, y: 0, z: -15 }, max: { x: 5, y: 0.35, z: -11 } }, // north of the bastion
  { min: { x: -5, y: 0, z: 11 }, max: { x: 5, y: 0.35, z: 15 } }, // south of the bastion
];

export function inHazard(x: number, y: number, z: number): boolean {
  for (const h of HAZARDS) {
    if (x > h.min.x && x < h.max.x && z > h.min.z && z < h.max.z && y < h.max.y) return true;
  }
  return false;
}

/** A bidirectional teleporter pair (NW corner ↔ SE corner). */
export interface TeleporterPad {
  pos: Vec3;
  /** Index of the destination pad in TELEPORTERS. */
  to: number;
  radius: number;
}

export const TELEPORTERS: TeleporterPad[] = [
  { pos: { x: -25, y: 0, z: -24.5 }, to: 1, radius: 1.0 },
  { pos: { x: 25, y: 0, z: 24.5 }, to: 0, radius: 1.0 },
];

/** Jump pads: standing on one launches you up (onto the decks / the bastion). */
export interface JumpPad {
  pos: Vec3;
  radius: number;
}

export const JUMP_PADS: JumpPad[] = [
  { pos: { x: -22, y: 0, z: 6.8 }, radius: 1.1 }, // onto the west deck
  { pos: { x: 22, y: 0, z: -6.8 }, radius: 1.1 }, // onto the east deck
  { pos: { x: 0, y: 0, z: 6.5 }, radius: 1.1 }, // onto the bastion roof
];

export type ItemKind = "weapon" | "health" | "overdrive" | "boots" | "overshield";

export interface ItemSpawn {
  id: number;
  kind: ItemKind;
  /** Set when kind === "weapon". */
  weapon?: WeaponId;
  pos: Vec3; // where the floating pickup hovers
  /** Respawn override, ms (default ITEM_RESPAWN_MS). The Smelter uses a long one. */
  respawnMs?: number;
  /** Announce respawns of this item to everyone (the Smelter event). */
  announce?: boolean;
}

export const ITEM_SPAWNS: ItemSpawn[] = [
  // The Armory counter: shotgun, rail, grenades.
  { id: 0, kind: "weapon", weapon: "scrapshot", pos: { x: -2.2, y: 1.45, z: -29.7 } },
  { id: 1, kind: "weapon", weapon: "arcwelder", pos: { x: 2.2, y: 1.45, z: -29.7 } },
  { id: 2, kind: "weapon", weapon: "frag", pos: { x: 0, y: 1.45, z: -29.7 } },
  // Field weapons.
  { id: 3, kind: "weapon", weapon: "scrapshot", pos: { x: -22, y: 2.55, z: 0 } }, // west deck top
  { id: 4, kind: "weapon", weapon: "arcwelder", pos: { x: 0, y: 2.85, z: 3.2 } }, // bastion top
  { id: 5, kind: "weapon", weapon: "frag", pos: { x: 0, y: 0.45, z: 17 } }, // south field
  // Medkits: sheltered under each side deck, plus one beside the north lava pool.
  { id: 6, kind: "health", pos: { x: -22, y: 0.45, z: 2.5 } },
  { id: 7, kind: "health", pos: { x: 22, y: 0.45, z: -2.5 } },
  { id: 8, kind: "health", pos: { x: 6.5, y: 0.45, z: -12 } },
  // Rockets on the east deck (mirror of the west deck's scrapshot).
  { id: 9, kind: "weapon", weapon: "lance", pos: { x: 22, y: 2.55, z: 0 } },
  // Power-ups.
  { id: 10, kind: "overdrive", pos: { x: 0, y: 2.85, z: -3.2 } }, // bastion roof, north
  { id: 11, kind: "boots", pos: { x: 11, y: 0.45, z: 0 } }, // east stair base
  // The secret chamber inside the bastion (shoot the north door panel).
  { id: 12, kind: "overshield", pos: { x: -1.6, y: 0.45, z: 0 }, respawnMs: 60_000 },
  { id: 13, kind: "weapon", weapon: "smelter", pos: { x: 1.6, y: 0.45, z: 0 }, respawnMs: 150_000, announce: true },
];

// --- Spawn points -----------------------------------------------------------------

function facingCenter(x: number, z: number, yawOffset = 0): SpawnPoint {
  // Forward at yaw 0 is (0,0,-1); forward = (-sin yaw, 0, -cos yaw).
  const len = Math.hypot(x, z) || 1;
  const fx = -x / len;
  const fz = -z / len;
  return { pos: { x, y: 0, z }, yaw: Math.atan2(-fx, -fz) + yawOffset };
}

/**
 * Eight spawn points in a ring around the perimeter, each facing the open
 * arena with cover at its back: the north spawn clears the Armory, the south
 * spawn stands in front of (not behind) its barrier, the side spawns shelter
 * under the decks, and the diagonals get a yaw offset so nobody spawns staring
 * into a pillar.
 */
export const SPAWN_POINTS: SpawnPoint[] = [
  facingCenter(8, -29),
  facingCenter(20, -20, -0.5),
  facingCenter(22, 0),
  facingCenter(20, 20, 0.5),
  facingCenter(0, 22),
  facingCenter(-20, 20, -0.5),
  facingCenter(-22, 0),
  facingCenter(-20, -20, 0.5),
];

// --- Bot navigation ----------------------------------------------------------------

export interface Waypoint {
  x: number;
  /** Standing height at this node (0 = floor; 2.5 = bastion top). */
  y: number;
  z: number;
}

/**
 * Navigation nodes for practice-mode bots: the spawn ring, the armory front,
 * the stair bases, and the bastion top. Edges are derived at runtime by
 * walkability sampling, so this list only has to be roughly sensible.
 */
export const WAYPOINTS: Waypoint[] = [
  ...SPAWN_POINTS.map((s) => ({ x: s.pos.x, y: 0, z: s.pos.z })),
  { x: 0, y: 0, z: -28 }, // armory front (bots shop too)
  { x: -11, y: 0, z: 0 }, // west stair base
  { x: 11, y: 0, z: 0 }, // east stair base
  { x: 0, y: 2.5, z: 3 }, // bastion top, south of the jumbotron
  { x: 0, y: 2.5, z: -3 }, // bastion top, north
  { x: 0, y: 0, z: 17 }, // south mid-field
  { x: -17, y: 0, z: -17 }, // open diagonals
  { x: 17, y: 0, z: 17 },
];
