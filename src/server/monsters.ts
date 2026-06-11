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
  fiend: { hp: 50, speed: 6.5, halfW: 0.5, height: 1.0 },
  drone: { hp: 40, speed: 4.2, halfW: 0.35, height: 0.7, altitude: 2.4 },
  warden: { hp: 800, speed: 3.2, halfW: 0.8, height: 2.6 },
};

export const FIEND_MELEE_DMG = 10;
export const FIEND_MELEE_RANGE = 1.6;
export const FIEND_MELEE_COOLDOWN_MS = 1100;
export const DRONE_BOLT_COOLDOWN_MS = 3200;
export const WARDEN_SLAM_DMG = 45;
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
export const WAVE_INTERMISSION_MS = 10_000;
export const HORDE_GAMEOVER_MS = 12_000;

/** Squad scaling: solo gets 1.0x monsters, each extra human adds 30%. */
export function squadMult(humans: number): number {
  return 0.7 + 0.3 * Math.min(4, Math.max(1, humans));
}

/** Early waves pull their punches so new players can learn the dance. */
export const EARLY_WAVE_MERCY = 0.7;
export const EARLY_WAVE_LIMIT = 2;

/**
 * Wave composition, scaled to the number of humans present. Every 5th wave
 * brings the Foundry Warden. Solo: wave 1 = 2 fiends, drones from wave 3.
 */
export function waveQueue(n: number, humans: number): MonsterKind[] {
  const mult = squadMult(humans);
  const queue: MonsterKind[] = [];
  if (n % 5 === 0) {
    queue.push("warden");
    const fiends = Math.min(10, Math.ceil((1 + n * 0.4) * mult));
    const drones = Math.min(6, Math.ceil((n / 5) * mult));
    for (let i = 0; i < fiends; i++) queue.push("fiend");
    for (let i = 0; i < drones; i++) queue.push("drone");
  } else {
    const fiends = Math.min(16, Math.ceil((1 + n * 0.8) * mult));
    const drones = n >= 3 ? Math.min(8, Math.ceil((n - 2) * 0.5 * mult)) : 0;
    for (let i = 0; i < fiends; i++) queue.push("fiend");
    for (let i = 0; i < drones; i++) queue.push("drone");
  }
  return queue;
}

/** Warden scales with depth and squad size. */
export function wardenHp(wave: number, humans: number): number {
  return Math.round((MONSTER_DEFS.warden.hp + (wave / 5 - 1) * 350) * squadMult(humans));
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
