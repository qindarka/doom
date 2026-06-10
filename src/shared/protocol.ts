// The WebSocket message protocol. Every message is a single JSON object with a
// `type` discriminator. Client→server and server→client unions are kept separate
// so each side can exhaustively switch on what it can actually receive.

export interface PlayerScore {
  id: string;
  name: string;
  color: number; // hex color assigned by the server
  kills: number;
  deaths: number;
}

/** Per-player entry inside a state snapshot. Compact keys: sent 20×/sec. */
export interface PlayerSnapshot {
  id: string;
  p: [number, number, number]; // feet position
  yaw: number;
  pitch: number;
  hp: number;
  dead: boolean;
}

// --- Client → Server ---------------------------------------------------------

export interface JoinMsg {
  type: "join";
  v: number; // PROTOCOL_VERSION
  name: string;
  /** Reconnect token from a previous `welcome`; restores score within the grace window. */
  token?: string;
}

export interface InputMsg {
  type: "input";
  p: [number, number, number];
  yaw: number;
  pitch: number;
  /** Spawn epoch echoed from the latest welcome/spawn; stale-epoch inputs are dropped. */
  e: number;
}

export interface ShootMsg {
  type: "shoot";
  o: [number, number, number]; // claimed eye position (validated server-side)
  d: [number, number, number]; // normalized direction
  e: number; // spawn epoch
}

export interface PingMsg {
  type: "ping";
  t: number; // client timestamp, echoed back verbatim
}

export type ClientMsg = JoinMsg | InputMsg | ShootMsg | PingMsg;

// --- Server → Client ---------------------------------------------------------

export interface WelcomeMsg {
  type: "welcome";
  id: string;
  token: string;
  color: number;
  spawn: [number, number, number];
  yaw: number;
  e: number; // initial spawn epoch
  hp: number;
  roster: PlayerScore[];
}

export interface RosterMsg {
  type: "roster";
  players: PlayerScore[];
}

export interface StateMsg {
  type: "state";
  players: PlayerSnapshot[];
}

/** A validated shot, broadcast to everyone (including the shooter) for tracers/audio. */
export interface ShotMsg {
  type: "shot";
  id: string; // shooter
  o: [number, number, number];
  d: [number, number, number];
  /** Distance along d where the shot ended (wall or player), for tracer endpoints. */
  t: number;
  hitId?: string; // player that was struck, if any
}

export interface HitMsg {
  type: "hit";
  id: string; // victim
  by: string; // shooter
  dmg: number;
  hp: number; // victim hp after damage
}

export interface DeathMsg {
  type: "death";
  id: string; // victim
  by: string; // killer
}

export interface SpawnMsg {
  type: "spawn";
  id: string;
  p: [number, number, number];
  yaw: number;
  e: number; // new spawn epoch for that player
  hp: number;
}

export interface FullMsg {
  type: "full";
  max: number;
}

export interface ErrorMsg {
  type: "error";
  reason: string;
}

export interface PongMsg {
  type: "pong";
  t: number;
}

export type ServerMsg =
  | WelcomeMsg
  | RosterMsg
  | StateMsg
  | ShotMsg
  | HitMsg
  | DeathMsg
  | SpawnMsg
  | FullMsg
  | ErrorMsg
  | PongMsg;

/** WebSocket close code the server uses when it kicks a socket it no longer recognises. */
export const CLOSE_REJOIN = 4001;
/** Close code after a "full" rejection. */
export const CLOSE_FULL = 4002;
/** Close code for idle timeouts. */
export const CLOSE_IDLE = 4003;
/** Close code when a newer connection with the same token took over this player. */
export const CLOSE_REPLACED = 4004;
/** Close code for a protocol-version mismatch — terminal until the page reloads. */
export const CLOSE_OUTDATED = 4005;

export function parseClientMsg(raw: unknown): ClientMsg | null {
  if (typeof raw !== "string" || raw.length > 2048) return null;
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof msg !== "object" || msg === null) return null;
  const m = msg as Record<string, unknown>;
  switch (m.type) {
    case "join":
      return typeof m.name === "string" && typeof m.v === "number"
        ? ({ type: "join", v: m.v, name: m.name, token: typeof m.token === "string" ? m.token : undefined })
        : null;
    case "input":
      return isVec3(m.p) && isNum(m.yaw) && isNum(m.pitch) && isNum(m.e)
        ? ({ type: "input", p: m.p as [number, number, number], yaw: m.yaw as number, pitch: m.pitch as number, e: m.e as number })
        : null;
    case "shoot":
      return isVec3(m.o) && isVec3(m.d) && isNum(m.e)
        ? ({ type: "shoot", o: m.o as [number, number, number], d: m.d as [number, number, number], e: m.e as number })
        : null;
    case "ping":
      return isNum(m.t) ? { type: "ping", t: m.t as number } : null;
    default:
      return null;
  }
}

function isNum(v: unknown): boolean {
  return typeof v === "number" && Number.isFinite(v);
}

function isVec3(v: unknown): boolean {
  return Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === "number" && Number.isFinite(n));
}
