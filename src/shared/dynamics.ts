// Dynamic geometry shared by client and server: the bastion's secret door and
// the elevator platform. Both are pure functions of server time, so both sides
// compute identical collision boxes (the client keeps a smoothed estimate of
// the server clock from state-snapshot timestamps).

import type { AABB } from "./map";

// --- The secret door (north face of the bastion) -------------------------------
// Shooting it slides it into the floor; it rises closed again after a while.

export const DOOR_BOX: AABB = {
  min: { x: -1.2, y: 0, z: -5.05 },
  max: { x: 1.2, y: 2.1, z: -3.75 },
};

/** Slide animation duration (the door is solid until fully open). */
export const DOOR_ANIM_MS = 600;
/** How long the door stays open before sealing again. */
export const DOOR_OPEN_FOR_MS = 20_000;

/** Where the secret chamber is (for the "SECRET FOUND" moment). */
export function inSecretChamber(x: number, y: number, z: number): boolean {
  return Math.abs(x) < 3.6 && Math.abs(z) < 3.6 && y < 2.0;
}

// --- The elevator (south wall, rises to the sniper ledge) ----------------------

export const ELEVATOR = {
  cx: -3.5,
  cz: 31.4,
  half: 1.3, // platform half-width
  thickness: 0.4,
  lowTop: 0.45,
  highTop: 4.4, // flush with the ledge top
  travelMs: 3500,
  holdMs: 1500,
};

const PERIOD = (ELEVATOR.travelMs + ELEVATOR.holdMs) * 2;

/** Platform top height at a given server time. */
export function elevatorTopAt(serverTime: number): number {
  const { lowTop, highTop, travelMs, holdMs } = ELEVATOR;
  const phase = ((serverTime % PERIOD) + PERIOD) % PERIOD;
  if (phase < travelMs) {
    return lowTop + (highTop - lowTop) * (phase / travelMs);
  }
  if (phase < travelMs + holdMs) return highTop;
  if (phase < travelMs * 2 + holdMs) {
    return highTop - (highTop - lowTop) * ((phase - travelMs - holdMs) / travelMs);
  }
  return lowTop;
}

export function elevatorBoxAt(serverTime: number): AABB {
  const top = elevatorTopAt(serverTime);
  return {
    min: { x: ELEVATOR.cx - ELEVATOR.half, y: top - ELEVATOR.thickness, z: ELEVATOR.cz - ELEVATOR.half },
    max: { x: ELEVATOR.cx + ELEVATOR.half, y: top, z: ELEVATOR.cz + ELEVATOR.half },
  };
}
