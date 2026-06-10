// Local player movement: WASD relative to view yaw, jump + gravity, and
// axis-separated AABB collision against the shared arena solids. The client
// simulates its own movement (the server sanity-checks it), which keeps the
// local feel instant.

import {
  AIR_ACCEL,
  EYE_HEIGHT,
  GRAVITY,
  GROUND_ACCEL,
  JUMP_VELOCITY,
  MOVE_SPEED,
  PLAYER_HEIGHT,
  PLAYER_RADIUS,
} from "../shared/constants";
import { ARENA_HALF, SOLIDS } from "../shared/map";
import type { Vec3 } from "../shared/map";
import { aabbIntersects, playerAABB, vec3 } from "../shared/math";
import type { Input } from "./input";

const MOUSE_SENS = 0.0023;
const MAX_PITCH = 1.55;
const EPS = 1e-3;
/** Max ledge height climbed automatically while grounded (stairs, kerbs). */
const STEP_UP = 0.55;

export class LocalPlayer {
  pos: Vec3 = vec3();
  vel: Vec3 = vec3();
  yaw = 0;
  pitch = 0;
  grounded = false;
  dead = false;
  /** Spawn epoch echoed in every input/shoot message. */
  epoch = 1;

  spawn(p: [number, number, number], yaw: number, epoch: number): void {
    this.pos = vec3(p[0], p[1], p[2]);
    this.vel = vec3();
    this.yaw = yaw;
    this.pitch = 0;
    this.grounded = true;
    this.dead = false;
    this.epoch = epoch;
  }

  eye(): Vec3 {
    return vec3(this.pos.x, this.pos.y + EYE_HEIGHT, this.pos.z);
  }

  /** Unit view direction (yaw 0 faces -Z). */
  viewDir(): Vec3 {
    const cp = Math.cos(this.pitch);
    return vec3(-Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp);
  }

  update(dt: number, input: Input): void {
    // Look — applied even while dead is handled by the caller (it skips update).
    const { dx, dy } = input.consumeMouse();
    this.yaw -= dx * MOUSE_SENS;
    this.pitch = Math.min(MAX_PITCH, Math.max(-MAX_PITCH, this.pitch - dy * MOUSE_SENS));

    // Wish velocity from WASD, rotated by yaw.
    const f = (input.isDown("KeyW") ? 1 : 0) - (input.isDown("KeyS") ? 1 : 0);
    const s = (input.isDown("KeyD") ? 1 : 0) - (input.isDown("KeyA") ? 1 : 0);
    let wishX = 0;
    let wishZ = 0;
    if (f !== 0 || s !== 0) {
      const fx = -Math.sin(this.yaw);
      const fz = -Math.cos(this.yaw);
      const rx = Math.cos(this.yaw);
      const rz = -Math.sin(this.yaw);
      wishX = f * fx + s * rx;
      wishZ = f * fz + s * rz;
      const len = Math.hypot(wishX, wishZ);
      wishX = (wishX / len) * MOVE_SPEED;
      wishZ = (wishZ / len) * MOVE_SPEED;
    }

    const accel = this.grounded ? GROUND_ACCEL : AIR_ACCEL;
    const blend = Math.min(1, accel * dt);
    this.vel.x += (wishX - this.vel.x) * blend;
    this.vel.z += (wishZ - this.vel.z) * blend;

    if (this.grounded && input.isDown("Space")) {
      this.vel.y = JUMP_VELOCITY;
      this.grounded = false;
    }

    this.vel.y -= GRAVITY * dt;

    this.moveAxis("x", this.vel.x * dt);
    this.moveAxis("z", this.vel.z * dt);
    this.moveVertical(this.vel.y * dt);
  }

  private moveAxis(axis: "x" | "z", delta: number): void {
    if (delta === 0) return;
    this.pos[axis] += delta;

    const lim = ARENA_HALF - PLAYER_RADIUS;
    this.pos[axis] = Math.min(lim, Math.max(-lim, this.pos[axis]));

    for (const solid of SOLIDS) {
      const box = playerAABB(this.pos);
      if (!aabbIntersects(box, solid)) continue;

      // Auto-step: a grounded walker climbs low ledges (stairs) if the space
      // on top is clear.
      if (this.grounded && solid.max.y <= this.pos.y + STEP_UP) {
        const lifted = vec3(this.pos.x, solid.max.y + EPS, this.pos.z);
        if (!this.collidesAny(lifted)) {
          this.pos.y = solid.max.y;
          continue;
        }
      }

      if (delta > 0) {
        this.pos[axis] = solid.min[axis] - PLAYER_RADIUS - EPS;
      } else {
        this.pos[axis] = solid.max[axis] + PLAYER_RADIUS + EPS;
      }
      this.vel[axis] = 0;
    }
  }

  private collidesAny(at: Vec3): boolean {
    const box = playerAABB(at);
    for (const solid of SOLIDS) {
      if (aabbIntersects(box, solid)) return true;
    }
    return false;
  }

  private moveVertical(delta: number): void {
    const feet = this.pos.y;
    const next = feet + delta;

    if (delta <= 0) {
      // Highest support under the player: the floor, or any solid top at-or-below
      // our feet whose footprint we overlap horizontally.
      let ground = 0;
      const box = playerAABB(this.pos);
      for (const solid of SOLIDS) {
        const overlapXZ =
          box.min.x < solid.max.x &&
          box.max.x > solid.min.x &&
          box.min.z < solid.max.z &&
          box.max.z > solid.min.z;
        if (!overlapXZ) continue;
        const top = solid.max.y;
        if (top <= feet + EPS && top > ground) ground = top;
      }
      if (next <= ground) {
        this.pos.y = ground;
        this.vel.y = 0;
        this.grounded = true;
        return;
      }
      this.grounded = false;
      this.pos.y = next;
    } else {
      // Rising: bump the head on overhangs (decks, the shop roof, the screen).
      this.grounded = false;
      this.pos.y = next;
      const box = playerAABB(this.pos);
      for (const solid of SOLIDS) {
        if (aabbIntersects(box, solid) && solid.min.y >= feet + 0.2) {
          this.pos.y = Math.max(feet, solid.min.y - PLAYER_HEIGHT - EPS);
          this.vel.y = 0;
          break;
        }
      }
    }
  }
}
