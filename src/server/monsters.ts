// Horde-mode monsters: definitions, wave composition, and AI state. The
// per-tick behaviour lives in GameRoom (it needs full room context).

export type MonsterKind = "fiend" | "drone" | "warden";

export interface MonsterDef {
  hp: number;
  speed: number;
  /** Hitbox half-width and height. */
  halfW: number;
  height: number;
  /** Flying altitude (drones); grounded kinds use the nav ground. */
  altitude?: number;
}

export const MONSTER_DEFS: Record<MonsterKind, MonsterDef> = {
  fiend: { hp: 60, speed: 7.5, halfW: 0.5, height: 1.0 },
  drone: { hp: 40, speed: 4.2, halfW: 0.35, height: 0.7, altitude: 2.4 },
  warden: { hp: 1100, speed: 3.2, halfW: 0.8, height: 2.6 },
};

export const FIEND_MELEE_DMG = 15;
export const FIEND_MELEE_RANGE = 1.6;
export const FIEND_MELEE_COOLDOWN_MS = 900;
export const DRONE_BOLT_COOLDOWN_MS = 2600;
export const WARDEN_SLAM_DMG = 60;
export const WARDEN_SLAM_RADIUS = 5;
export const WARDEN_TELEGRAPH_MS = 1200;
export const WARDEN_SLAM_COOLDOWN_MS = 4500;
export const WARDEN_FRAG_COOLDOWN_MS = 7000;

/** Where monsters crawl out of the walls (vent grates, visually). */
export const VENTS: Array<{ x: number; z: number }> = [
  { x: 8, z: -33 },
  { x: -8, z: 33 },
  { x: -33, z: 8 },
  { x: 33, z: -8 },
];

export const WAVE_SPAWN_STAGGER_MS = 1200;
export const WAVE_INTERMISSION_MS = 8000;
export const HORDE_GAMEOVER_MS = 12_000;

/** Wave composition: every 5th wave brings the Foundry Warden. */
export function waveQueue(n: number): MonsterKind[] {
  const queue: MonsterKind[] = [];
  if (n % 5 === 0) {
    queue.push("warden");
    for (let i = 0; i < Math.min(10, 2 + n / 2); i++) queue.push("fiend");
    for (let i = 0; i < Math.min(6, n / 2); i++) queue.push("drone");
  } else {
    for (let i = 0; i < Math.min(16, 3 + n * 2); i++) queue.push("fiend");
    for (let i = 0; i < Math.min(8, n - 1); i++) queue.push("drone");
  }
  return queue;
}

/** Warden scales with how deep you've survived. */
export function wardenHp(wave: number): number {
  return MONSTER_DEFS.warden.hp + (wave / 5 - 1) * 400;
}

export interface Monster {
  id: number;
  kind: MonsterKind;
  pos: { x: number; y: number; z: number };
  yaw: number;
  hp: number;
  maxHp: number;
  targetId: string | null;
  retargetAt: number;
  path: number[];
  pathIdx: number;
  repathAt: number;
  nextAttackAt: number;
  /** Warden: a slam lands at this time (0 = none pending). */
  slamAt: number;
  slamPos: { x: number; y: number; z: number } | null;
  nextFragAt: number;
}
