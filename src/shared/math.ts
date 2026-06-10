// Geometry helpers shared by the server (authoritative raycasts) and the client
// (movement collision, predicted tracer endpoints). Pure functions, no deps.

import type { AABB, Vec3 } from "./map";
import { PLAYER_HEIGHT, PLAYER_RADIUS } from "./constants";

export function vec3(x = 0, y = 0, z = 0): Vec3 {
  return { x, y, z };
}

export function distSq(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}

export function dist(a: Vec3, b: Vec3): number {
  return Math.sqrt(distSq(a, b));
}

export function normalize(v: Vec3): Vec3 {
  const len = Math.hypot(v.x, v.y, v.z);
  if (len < 1e-8) return vec3(0, 0, -1);
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

/** The collision/hit box for a player whose feet are at `feet`. */
export function playerAABB(feet: Vec3): AABB {
  return {
    min: { x: feet.x - PLAYER_RADIUS, y: feet.y, z: feet.z - PLAYER_RADIUS },
    max: { x: feet.x + PLAYER_RADIUS, y: feet.y + PLAYER_HEIGHT, z: feet.z + PLAYER_RADIUS },
  };
}

export function aabbIntersects(a: AABB, b: AABB): boolean {
  return (
    a.min.x < b.max.x &&
    a.max.x > b.min.x &&
    a.min.y < b.max.y &&
    a.max.y > b.min.y &&
    a.min.z < b.max.z &&
    a.max.z > b.min.z
  );
}

export function aabbOverlapsXZ(a: AABB, b: AABB): boolean {
  return a.min.x < b.max.x && a.max.x > b.min.x && a.min.z < b.max.z && a.max.z > b.min.z;
}

/**
 * Slab-method ray vs AABB. Returns the entry distance t >= 0 along the
 * (normalized) direction, or null if there is no hit with t in [0, maxT].
 * A ray starting inside the box returns t = 0.
 */
export function rayAABB(origin: Vec3, dir: Vec3, box: AABB, maxT: number): number | null {
  let tMin = 0;
  let tMax = maxT;

  const axes: ["x", "y", "z"] = ["x", "y", "z"];
  for (const ax of axes) {
    const o = origin[ax];
    const d = dir[ax];
    const lo = box.min[ax];
    const hi = box.max[ax];
    if (Math.abs(d) < 1e-9) {
      if (o < lo || o > hi) return null;
    } else {
      let t1 = (lo - o) / d;
      let t2 = (hi - o) / d;
      if (t1 > t2) {
        const tmp = t1;
        t1 = t2;
        t2 = tmp;
      }
      if (t1 > tMin) tMin = t1;
      if (t2 < tMax) tMax = t2;
      if (tMin > tMax) return null;
    }
  }
  return tMin;
}

/** Nearest hit distance of a ray against a list of boxes, or null. */
export function rayAABBs(origin: Vec3, dir: Vec3, boxes: AABB[], maxT: number): number | null {
  let best: number | null = null;
  for (const b of boxes) {
    const t = rayAABB(origin, dir, b, maxT);
    if (t !== null && (best === null || t < best)) best = t;
  }
  return best;
}

/**
 * A random direction within a cone of half-angle `maxAngle` around `dir`
 * (uniform over the cone disc). Used for shotgun pellet scatter and bot aim
 * error; the server's roll is authoritative, client rolls are visual-only.
 */
export function perturbDir(dir: Vec3, maxAngle: number): Vec3 {
  if (maxAngle <= 0) return dir;
  const up = Math.abs(dir.y) < 0.99 ? vec3(0, 1, 0) : vec3(1, 0, 0);
  // u = normalize(dir × up), v = dir × u
  const u = normalize(vec3(dir.y * up.z - dir.z * up.y, dir.z * up.x - dir.x * up.z, dir.x * up.y - dir.y * up.x));
  const v = vec3(dir.y * u.z - dir.z * u.y, dir.z * u.x - dir.x * u.z, dir.x * u.y - dir.y * u.x);
  const theta = Math.random() * Math.PI * 2;
  const r = maxAngle * Math.sqrt(Math.random());
  const cu = Math.cos(theta) * r;
  const cv = Math.sin(theta) * r;
  return normalize(vec3(dir.x + u.x * cu + v.x * cv, dir.y + u.y * cu + v.y * cv, dir.z + u.z * cu + v.z * cv));
}
