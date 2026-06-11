// Remote player avatars: capsule bodies built per roster entry, driven by a
// snapshot buffer and rendered ~120ms in the past for smooth interpolation.

import * as THREE from "three";

import {
  BUFF_BOOTS,
  BUFF_OVERDRIVE,
  DEFAULT_WEAPON,
  INTERP_DELAY_MS,
  PLAYER_HEIGHT,
  WEAPONS,
} from "../shared/constants";
import type { WeaponId } from "../shared/constants";
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
  private readonly head: THREE.Group;
  private readonly nameSprite: THREE.Sprite;
  private gun!: THREE.Group;
  private legL!: THREE.Group;
  private legR!: THREE.Group;
  private armL!: THREE.Group;
  private buffLight: THREE.PointLight | null = null;
  private weapon: WeaponId = DEFAULT_WEAPON;
  private buffer: Snapshot[] = [];
  private walkPhase = 0;
  private lastPose = { x: 0, z: 0, t: 0 };
  dead = false;

  constructor(score: PlayerScore) {
    this.builtName = score.name;
    this.builtColor = score.color;

    // Original armored-trooper design: dark undersuit with color-coded armor
    // plates, a full helmet and a glowing amber visor. Feet sit at the group
    // origin; total height matches PLAYER_HEIGHT.
    const armor = new THREE.MeshStandardMaterial({
      color: new THREE.Color(score.color).multiplyScalar(0.85),
      roughness: 0.45,
      metalness: 0.55,
    });
    const suit = new THREE.MeshStandardMaterial({
      color: 0x1c2128,
      roughness: 0.7,
      metalness: 0.35,
    });
    const visorMat = new THREE.MeshBasicMaterial({ color: 0xffb649 });

    const addBox = (
      parent: THREE.Object3D,
      mat: THREE.Material,
      w: number,
      h: number,
      d: number,
      x: number,
      y: number,
      z: number,
    ): THREE.Mesh => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      mesh.position.set(x, y, z);
      mesh.castShadow = true;
      parent.add(mesh);
      return mesh;
    };

    // Legs pivot at the hips so they can swing while walking.
    this.legL = new THREE.Group();
    this.legL.position.set(-0.15, 0.92, 0);
    addBox(this.legL, armor, 0.2, 0.42, 0.24, 0, -0.21, 0); // thigh plate
    addBox(this.legL, suit, 0.16, 0.42, 0.18, 0, -0.62, 0); // shin
    addBox(this.legL, armor, 0.18, 0.12, 0.3, 0, -0.86, -0.03); // boot
    this.group.add(this.legL);
    this.legR = new THREE.Group();
    this.legR.position.set(0.15, 0.92, 0);
    addBox(this.legR, armor, 0.2, 0.42, 0.24, 0, -0.21, 0);
    addBox(this.legR, suit, 0.16, 0.42, 0.18, 0, -0.62, 0);
    addBox(this.legR, armor, 0.18, 0.12, 0.3, 0, -0.86, -0.03);
    this.group.add(this.legR);

    // Torso: undersuit core, sculpted chest plate, belt, back unit.
    addBox(this.group, suit, 0.42, 0.5, 0.26, 0, 1.18, 0);
    addBox(this.group, armor, 0.46, 0.34, 0.3, 0, 1.27, -0.01); // chest plate
    addBox(this.group, armor, 0.36, 0.1, 0.26, 0, 0.97, 0); // belt
    addBox(this.group, suit, 0.3, 0.34, 0.14, 0, 1.25, 0.2); // back unit
    addBox(this.group, visorMat, 0.1, 0.04, 0.02, 0, 1.36, -0.155); // chest lamp

    // Pauldrons.
    addBox(this.group, armor, 0.18, 0.16, 0.26, -0.3, 1.42, 0);
    addBox(this.group, armor, 0.18, 0.16, 0.26, 0.3, 1.42, 0);

    // Arms: the right one is posed onto the gun; the left swings while walking.
    this.armL = new THREE.Group();
    this.armL.position.set(-0.31, 1.4, 0);
    addBox(this.armL, suit, 0.12, 0.34, 0.14, 0, -0.18, 0);
    addBox(this.armL, armor, 0.13, 0.2, 0.15, 0, -0.43, 0); // forearm guard
    this.group.add(this.armL);
    const armR = new THREE.Group();
    armR.position.set(0.31, 1.4, 0);
    armR.rotation.x = -0.9;
    addBox(armR, suit, 0.12, 0.34, 0.14, 0, -0.18, 0);
    addBox(armR, armor, 0.13, 0.2, 0.15, 0, -0.43, 0);
    this.group.add(armR);

    // Helmet: rounded dome over a jaw guard, wide glowing visor, side fins.
    this.head = new THREE.Group();
    const dome = new THREE.Mesh(new THREE.SphereGeometry(0.17, 14, 12), armor);
    dome.scale.set(1, 0.92, 1.08);
    dome.position.y = 0.06;
    dome.castShadow = true;
    this.head.add(dome);
    addBox(this.head, suit, 0.24, 0.14, 0.26, 0, -0.05, 0.01); // jaw guard
    const visor = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.09, 0.06), visorMat);
    visor.position.set(0, 0.04, -0.15);
    this.head.add(visor);
    addBox(this.head, armor, 0.05, 0.08, 0.16, -0.17, 0.02, 0.02); // ear fins
    addBox(this.head, armor, 0.05, 0.08, 0.16, 0.17, 0.02, 0.02);
    this.head.position.y = PLAYER_HEIGHT - 0.2;
    this.group.add(this.head);

    // Gun stub on the right side, rebuilt when the held weapon changes.
    this.gun = new THREE.Group();
    this.gun.position.set(0.32, 1.25, -0.25);
    this.group.add(this.gun);
    this.buildGun(DEFAULT_WEAPON);

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

  setWeapon(w: WeaponId): void {
    if (w === this.weapon) return;
    this.weapon = w;
    this.buildGun(w);
  }

  private buildGun(w: WeaponId): void {
    for (const child of [...this.gun.children]) {
      this.gun.remove(child);
      if (child instanceof THREE.Mesh) {
        child.geometry.dispose();
        (child.material as THREE.Material).dispose();
      }
    }
    const dark = new THREE.MeshStandardMaterial({ color: 0x14181d, roughness: 0.4, metalness: 0.7 });
    if (w === "scrapshot") {
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.15, 0.5), dark);
      this.gun.add(body);
      const band = new THREE.Mesh(
        new THREE.BoxGeometry(0.16, 0.1, 0.07),
        new THREE.MeshBasicMaterial({ color: WEAPONS.scrapshot.color }),
      );
      band.position.set(0, 0, -0.26);
      this.gun.add(band);
    } else if (w === "arcwelder") {
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.1, 0.75), dark);
      this.gun.add(body);
      const coil = new THREE.Mesh(
        new THREE.TorusGeometry(0.07, 0.016, 6, 12),
        new THREE.MeshBasicMaterial({ color: WEAPONS.arcwelder.color }),
      );
      coil.position.set(0, 0, -0.3);
      this.gun.add(coil);
    } else {
      this.gun.add(new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.12, 0.55), dark));
    }
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

  /** Returns true on the alive→dead transition (the manager spawns gibs). */
  setDead(dead: boolean): boolean {
    const justDied = dead && !this.dead;
    this.dead = dead;
    return justDied;
  }

  /** Buff bitmask from the snapshot: a glow telegraphs power-ups to everyone. */
  setBuffs(b: number): void {
    if (!this.buffLight) {
      this.buffLight = new THREE.PointLight(0xffffff, 0, 5, 1.8);
      this.buffLight.position.y = 1.2;
      this.group.add(this.buffLight);
    }
    if (b & BUFF_OVERDRIVE) {
      this.buffLight.color.setHex(0xffffff);
      this.buffLight.intensity = 7;
    } else if (b & BUFF_BOOTS) {
      this.buffLight.color.setHex(0x00ffc8);
      this.buffLight.intensity = 4;
    } else {
      this.buffLight.intensity = 0;
    }
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

    // Dead troopers burst into gibs (spawned by the Remotes manager); the body
    // simply vanishes until the respawn snapshot.
    this.group.visible = !this.dead;
    this.nameSprite.visible = !this.dead;
  }

  private applyPose(x: number, y: number, z: number, yaw: number, pitch: number): void {
    this.group.position.set(x, y, z);
    this.group.rotation.y = yaw;
    this.head.rotation.x = pitch * 0.7;

    // Walk cycle: swing legs and the off-hand arm by horizontal speed.
    const now = performance.now();
    const dt = Math.min(0.1, Math.max(0.001, (now - this.lastPose.t) / 1000));
    const speed = Math.hypot(x - this.lastPose.x, z - this.lastPose.z) / dt;
    this.lastPose = { x, z, t: now };
    if (this.dead) return;
    const clamped = Math.min(speed, 10);
    this.walkPhase += clamped * dt * 6;
    const swing = Math.sin(this.walkPhase) * Math.min(1, clamped / 6) * 0.55;
    this.legL.rotation.x = swing;
    this.legR.rotation.x = -swing;
    this.armL.rotation.x = -swing * 0.7;
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
  /** Fired on each avatar's alive→dead transition (the game spawns gibs). */
  onDeath: (id: string, pos: THREE.Vector3, color: number) => void = () => {};

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
      if (avatar.setDead(snap.dead)) {
        this.onDeath(
          snap.id,
          new THREE.Vector3(snap.p[0], snap.p[1], snap.p[2]),
          avatar.builtColor,
        );
      }
      avatar.setWeapon(snap.w);
      avatar.setBuffs(snap.b);
    }
  }

  teleport(id: string, p: [number, number, number], yaw: number, now: number): void {
    this.avatars.get(id)?.teleport(p, yaw, now);
  }

  positionOf(id: string): THREE.Vector3 | null {
    const avatar = this.avatars.get(id);
    return avatar && avatar.group.visible ? avatar.group.position.clone() : null;
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
