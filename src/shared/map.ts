// The arena, defined as data so the client (rendering, collision) and the server
// (raycast hit validation, spawn points, bounds checks) are guaranteed to agree.
//
// Coordinates: Y is up, the floor is y = 0. The arena is a square centred on the
// origin, enclosed by four boundary walls. All solids are axis-aligned boxes.

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
export const ARENA_HALF = 26;
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

export type ObstacleKind = "monolith" | "pillar" | "barrier" | "crate" | "lowcrate";

export interface Obstacle extends AABB {
  kind: ObstacleKind;
}

function obs(kind: ObstacleKind, b: AABB): Obstacle {
  return { kind, min: b.min, max: b.max };
}

/**
 * Cover inside the arena. Jump apex is ~1.3m, so 1m crates are climbable,
 * 2m crates and taller are pure cover.
 */
export const OBSTACLES: Obstacle[] = [
  // Central monolith — the core sightline blocker.
  obs("monolith", box(0, 0, 7, 7, 3)),

  // Four pillars on the mid ring.
  obs("pillar", box(-11, -11, 1.6, 1.6, WALL_HEIGHT)),
  obs("pillar", box(11, -11, 1.6, 1.6, WALL_HEIGHT)),
  obs("pillar", box(-11, 11, 1.6, 1.6, WALL_HEIGHT)),
  obs("pillar", box(11, 11, 1.6, 1.6, WALL_HEIGHT)),

  // Mid-side barriers (chest-high lanes along each wall).
  obs("barrier", box(0, -17, 8, 1, 2.2)),
  obs("barrier", box(0, 17, 8, 1, 2.2)),
  obs("barrier", box(-17, 0, 1, 8, 2.2)),
  obs("barrier", box(17, 0, 1, 8, 2.2)),

  // Corner crate clusters: one tall (cover) + one low (climbable) each.
  obs("crate", box(19, 19, 2, 2, 2)),
  obs("lowcrate", box(16.4, 19.2, 1.4, 1.4, 1)),
  obs("crate", box(-19, 19, 2, 2, 2)),
  obs("lowcrate", box(-16.4, 19.2, 1.4, 1.4, 1)),
  obs("crate", box(19, -19, 2, 2, 2)),
  obs("lowcrate", box(16.4, -19.2, 1.4, 1.4, 1)),
  obs("crate", box(-19, -19, 2, 2, 2)),
  obs("lowcrate", box(-16.4, -19.2, 1.4, 1.4, 1)),

  // Two off-centre low blocks to break up the inner diagonals.
  obs("lowcrate", box(-6, 8.5, 2.4, 2.4, 1)),
  obs("lowcrate", box(6, -8.5, 2.4, 2.4, 1)),
];

/** Everything a hitscan ray or a moving player can collide with. */
export const SOLIDS: AABB[] = [...WALLS, ...OBSTACLES];

function facingCenter(x: number, z: number, yawOffset = 0): SpawnPoint {
  // Forward at yaw 0 is (0,0,-1); forward = (-sin yaw, 0, -cos yaw).
  const len = Math.hypot(x, z) || 1;
  const fx = -x / len;
  const fz = -z / len;
  return { pos: { x, y: 0, z }, yaw: Math.atan2(-fx, -fz) + yawOffset };
}

/**
 * Eight spawn points around the perimeter, each facing the arena centre.
 * Diagonal spawns get a yaw offset so players don't spawn staring straight
 * into the mid-ring pillars that sit on the diagonals.
 */
export const SPAWN_POINTS: SpawnPoint[] = [
  facingCenter(0, -21),
  facingCenter(0, 21),
  facingCenter(-21, 0),
  facingCenter(21, 0),
  facingCenter(-14, -14, 0.5),
  facingCenter(14, -14, -0.5),
  facingCenter(-14, 14, -0.5),
  facingCenter(14, 14, 0.5),
];
