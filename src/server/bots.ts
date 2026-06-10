// Practice-mode bot support: a waypoint navigation graph derived from the
// shared map by walkability sampling, plus the per-bot AI state. The actual
// per-tick bot behaviour lives in GameRoom (it needs full room context); this
// module owns everything that is pure geometry/state.

import { PLAYER_RADIUS } from "../shared/constants";
import { SOLIDS, WAYPOINTS } from "../shared/map";
import type { Vec3 } from "../shared/map";
import { aabbIntersects, playerAABB, vec3 } from "../shared/math";

export const BOT_NAMES = ["RIVET-7", "SLAG-9", "FLUX-3", "GRIND-5", "WELD-2", "SCRAP-8"];

export const BOT_SPEED = 6.5; // m/s, a touch slower than humans
export const BOT_SCAN_MS = 250; // how often bots re-evaluate targets
export const BOT_REACTION_MS = 320; // delay between seeing and first shot
export const BOT_ENGAGE_RANGE = 55;

export interface BotBrain {
  targetId: string | null;
  /** Set when the current target first became visible; first shot waits for it. */
  reactAt: number;
  scanAt: number;
  path: number[];
  pathIdx: number;
  repathAt: number;
  strafeDir: number;
  strafeUntil: number;
}

export function newBrain(): BotBrain {
  return {
    targetId: null,
    reactAt: 0,
    scanAt: 0,
    path: [],
    pathIdx: 0,
    repathAt: 0,
    strafeDir: 1,
    strafeUntil: 0,
  };
}

/** How high a walking bot can step up between samples (matches client step-up). */
const STEP_UP = 0.6;
const SAMPLE_STEP = 0.6;

/**
 * Ground height for a walker at (x,z) whose feet were at prevY: the highest
 * solid top within step-up reach, else the floor. Lets bots climb stairs and
 * walk on decks without simulating jumps.
 */
export function stepGround(x: number, z: number, prevY: number): number {
  const box = playerAABB(vec3(x, prevY, z));
  let ground = 0;
  for (const solid of SOLIDS) {
    if (
      box.min.x < solid.max.x &&
      box.max.x > solid.min.x &&
      box.min.z < solid.max.z &&
      box.max.z > solid.min.z &&
      solid.max.y <= prevY + STEP_UP &&
      solid.max.y > ground
    ) {
      ground = solid.max.y;
    }
  }
  return ground;
}

/** True if a player-sized walker standing at (x,y,z) is embedded in geometry. */
export function embedded(x: number, y: number, z: number): boolean {
  const box = playerAABB(vec3(x, y, z));
  const eps = 0.05;
  box.min.x += eps;
  box.min.y += eps;
  box.min.z += eps;
  box.max.x -= eps;
  box.max.y -= eps;
  box.max.z -= eps;
  for (const solid of SOLIDS) {
    if (aabbIntersects(box, solid)) return true;
  }
  return false;
}

/** Walkability between two waypoints by sampling the straight segment. */
function walkable(ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean {
  const dist = Math.hypot(bx - ax, bz - az);
  const steps = Math.max(1, Math.ceil(dist / SAMPLE_STEP));
  let y = ay;
  for (let i = 1; i <= steps; i++) {
    const x = ax + ((bx - ax) * i) / steps;
    const z = az + ((bz - az) * i) / steps;
    y = stepGround(x, z, y);
    if (embedded(x, y, z)) return false;
  }
  return Math.abs(y - by) <= STEP_UP;
}

let navEdges: number[][] | null = null;

/** Adjacency lists over WAYPOINTS, computed once per isolate. */
export function navGraph(): number[][] {
  if (navEdges) return navEdges;
  const n = WAYPOINTS.length;
  navEdges = Array.from({ length: n }, () => []);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = WAYPOINTS[i];
      const b = WAYPOINTS[j];
      if (Math.hypot(b.x - a.x, b.z - a.z) > 30) continue; // keep the graph local
      if (walkable(a.x, a.y, a.z, b.x, b.y, b.z) && walkable(b.x, b.y, b.z, a.x, a.y, a.z)) {
        navEdges[i].push(j);
        navEdges[j].push(i);
      }
    }
  }
  return navEdges;
}

export function nearestNode(pos: Vec3): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < WAYPOINTS.length; i++) {
    const w = WAYPOINTS[i];
    const d = Math.hypot(w.x - pos.x, w.z - pos.z) + Math.abs(w.y - pos.y) * 3;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/** BFS path (node indices), including `to`; empty if unreachable or trivial. */
export function findPath(from: number, to: number): number[] {
  if (from === to) return [];
  const edges = navGraph();
  const prev = new Array<number>(WAYPOINTS.length).fill(-1);
  const queue = [from];
  prev[from] = from;
  while (queue.length > 0) {
    const cur = queue.shift() as number;
    if (cur === to) break;
    for (const next of edges[cur]) {
      if (prev[next] === -1) {
        prev[next] = cur;
        queue.push(next);
      }
    }
  }
  if (prev[to] === -1) return [];
  const path: number[] = [];
  for (let at = to; at !== from; at = prev[at]) path.unshift(at);
  return path;
}

/** Keep bots off the very edge of the arena. */
export function clampToArena(v: Vec3, half: number): void {
  const lim = half - PLAYER_RADIUS;
  v.x = Math.min(lim, Math.max(-lim, v.x));
  v.z = Math.min(lim, Math.max(-lim, v.z));
}
