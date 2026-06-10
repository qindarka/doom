// Remote player avatars: capsule bodies built per roster entry, driven by a
// snapshot buffer and rendered ~120ms in the past for smooth interpolation.

import * as THREE from "three";

import { INTERP_DELAY_MS, PLAYER_HEIGHT } from "../shared/constants";
import type { PlayerScore, PlayerSnapshot } from "../shared/protocol";
import { nameTexture } from "./textures";

interface Snapshot {
  t: number; // local receive time, ms
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
}

const BUFFER_MAX_AGE_MS = 1200;
const DEATH_ANIM_MS = 450;

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpAngle(a: number, b: number, t: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

class RemoteAvatar {
  readonly group = new THREE.Group();
  /** The roster identity this avatar was built for (rebuilt if either changes). */
  readonly builtName: string;
  readonly builtColor: number;
  private readonly body: THREE.Mesh;
  private readonly head: THREE.Group;
  private readonly nameSprite: THREE.Sprite;
  private buffer: Snapshot[] = [];
  dead = false;
  private deathStart = 0;

  constructor(score: PlayerScore) {
    this.builtName = score.name;
    this.builtColor = score.color;
    const color = new THREE.Color(score.color);

    // Torso capsule: radius 0.34, total height ~1.5, base offset so feet = group origin.
    const bodyMat = new THREE.MeshStandardMaterial({
      color,
      roughness: 0.55,
      metalness: 0.35,
      emissive: color,
      emissiveIntensity: 0.12,
    });
    this.body = new THREE.Mesh(new THREE.CapsuleGeometry(0.34, 0.82, 6, 14), bodyMat);
    this.body.position.y = 0.75;
    this.body.castShadow = true;
    this.group.add(this.body);

    // Head with a glowing visor strip facing -Z (the avatar's forward).
    this.head = new THREE.Group();
    const skull = new THREE.Mesh(
      new THREE.BoxGeometry(0.42, 0.36, 0.42),
      new THREE.MeshStandardMaterial({ color: 0x2a313a, roughness: 0.5, metalness: 0.6 }),
    );
    skull.castShadow = true;
    this.head.add(skull);
    const visor = new THREE.Mesh(
      new THREE.BoxGeometry(0.3, 0.09, 0.05),
      new THREE.MeshBasicMaterial({ color: score.color }),
    );
    visor.position.set(0, 0.03, -0.21);
    this.head.add(visor);
    this.head.position.y = PLAYER_HEIGHT - 0.22;
    this.group.add(this.head);

    // Gun stub on the right side.
    const gun = new THREE.Mesh(
      new THREE.BoxGeometry(0.1, 0.12, 0.55),
      new THREE.MeshStandardMaterial({ color: 0x14181d, roughness: 0.4, metalness: 0.7 }),
    );
    gun.position.set(0.32, 1.25, -0.25);
    this.group.add(gun);

    this.nameSprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: nameTexture(score.name, score.color), transparent: true }),
    );
    this.nameSprite.scale.set(2.2, 0.55, 1);
    this.nameSprite.position.y = PLAYER_HEIGHT + 0.45;
    this.group.add(this.nameSprite);

    this.group.visible = false; // until the first snapshot arrives
  }

  /** World position of the avatar's muzzle area (for remote tracer starts). */
  muzzle(): THREE.Vector3 {
    const v = new THREE.Vector3(0.32, 1.25, -0.6);
    return this.group.localToWorld(v);
  }

  push(snap: PlayerSnapshot, now: number): void {
    this.buffer.push({
      t: now,
      x: snap.p[0],
      y: snap.p[1],
      z: snap.p[2],
      yaw: snap.yaw,
      pitch: snap.pitch,
    });
    const cutoff = now - BUFFER_MAX_AGE_MS;
    while (this.buffer.length > 2 && this.buffer[0].t < cutoff) this.buffer.shift();
  }

  /** Hard reset (respawn teleport): forget history so we don't lerp across the map. */
  teleport(p: [number, number, number], yaw: number, now: number): void {
    this.buffer = [{ t: now, x: p[0], y: p[1], z: p[2], yaw, pitch: 0 }];
    this.group.position.set(p[0], p[1], p[2]);
    this.group.rotation.y = yaw;
  }

  setDead(dead: boolean, now: number): void {
    if (dead && !this.dead) this.deathStart = now;
    this.dead = dead;
  }

  update(now: number): void {
    if (this.buffer.length === 0) return;
    this.group.visible = true;

    const renderTime = now - INTERP_DELAY_MS;
    let pos: Snapshot;

    if (this.buffer.length === 1 || renderTime <= this.buffer[0].t) {
      pos = this.buffer[0];
      this.applyPose(pos.x, pos.y, pos.z, pos.yaw, pos.pitch);
    } else {
      const last = this.buffer[this.buffer.length - 1];
      if (renderTime >= last.t) {
        // Snapshots stalled (packet loss / tab hidden): hold the last known pose.
        this.applyPose(last.x, last.y, last.z, last.yaw, last.pitch);
      } else {
        let i = this.buffer.length - 2;
        while (i > 0 && this.buffer[i].t > renderTime) i--;
        const a = this.buffer[i];
        const b = this.buffer[i + 1];
        const span = Math.max(b.t - a.t, 1);
        const t = Math.min(1, Math.max(0, (renderTime - a.t) / span));
        this.applyPose(
          lerp(a.x, b.x, t),
          lerp(a.y, b.y, t),
          lerp(a.z, b.z, t),
          lerpAngle(a.yaw, b.yaw, t),
          lerp(a.pitch, b.pitch, t),
        );
      }
    }

    // Death/respawn animation: keel over and sink.
    if (this.dead) {
      const k = Math.min(1, (now - this.deathStart) / DEATH_ANIM_MS);
      this.group.rotation.z = (Math.PI / 2) * k;
      this.group.position.y -= 0.6 * k;
      this.nameSprite.visible = false;
    } else {
      this.group.rotation.z = 0;
      this.nameSprite.visible = true;
    }
  }

  private applyPose(x: number, y: number, z: number, yaw: number, pitch: number): void {
    this.group.position.set(x, y, z);
    this.group.rotation.y = yaw;
    this.head.rotation.x = pitch * 0.7;
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.group);
    this.group.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose();
        (obj.material as THREE.Material).dispose();
      }
      if (obj instanceof THREE.Sprite) {
        obj.material.map?.dispose();
        obj.material.dispose();
      }
    });
  }
}

export class Remotes {
  private avatars = new Map<string, RemoteAvatar>();
  private scene: THREE.Scene;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  /** Reconcile avatars with the roster (add joins, drop leaves, rebuild on rename). */
  sync(roster: PlayerScore[], myId: string): void {
    const seen = new Set<string>();
    for (const entry of roster) {
      if (entry.id === myId) continue;
      seen.add(entry.id);
      const existing = this.avatars.get(entry.id);
      if (existing && (existing.builtName !== entry.name || existing.builtColor !== entry.color)) {
        // Renamed in place (reconnect adoption keeps the id): rebuild the avatar
        // so the floating name tag matches the scoreboard.
        existing.dispose(this.scene);
        this.avatars.delete(entry.id);
      }
      if (!this.avatars.has(entry.id)) {
        const avatar = new RemoteAvatar(entry);
        this.avatars.set(entry.id, avatar);
        this.scene.add(avatar.group);
      }
    }
    for (const [id, avatar] of this.avatars) {
      if (!seen.has(id)) {
        avatar.dispose(this.scene);
        this.avatars.delete(id);
      }
    }
  }

  onState(players: PlayerSnapshot[], myId: string, now: number): void {
    for (const snap of players) {
      if (snap.id === myId) continue;
      const avatar = this.avatars.get(snap.id);
      if (!avatar) continue;
      avatar.push(snap, now);
      avatar.setDead(snap.dead, now);
    }
  }

  teleport(id: string, p: [number, number, number], yaw: number, now: number): void {
    this.avatars.get(id)?.teleport(p, yaw, now);
  }

  muzzleOf(id: string): THREE.Vector3 | null {
    const avatar = this.avatars.get(id);
    return avatar && avatar.group.visible ? avatar.muzzle() : null;
  }

  update(now: number): void {
    for (const avatar of this.avatars.values()) avatar.update(now);
  }

  /** Current avatar positions, for the client-side predicted tracer endpoint. */
  positions(): Array<{ id: string; x: number; y: number; z: number }> {
    const out: Array<{ id: string; x: number; y: number; z: number }> = [];
    for (const [id, avatar] of this.avatars) {
      if (!avatar.group.visible || avatar.dead) continue;
      out.push({ id, x: avatar.group.position.x, y: avatar.group.position.y, z: avatar.group.position.z });
    }
    return out;
  }
}
