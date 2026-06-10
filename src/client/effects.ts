// Combat visual effects: the first-person viewmodel (with recoil), hitscan
// tracers, muzzle flashes and impact sparks. Everything is built from
// primitives and pooled/disposed aggressively.

import * as THREE from "three";

interface Transient {
  obj: THREE.Object3D;
  mat: THREE.Material & { opacity: number };
  born: number;
  ttl: number;
  grow?: number;
}

export class Effects {
  private scene: THREE.Scene;
  private transients: Transient[] = [];

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  /** Glowing beam from `from` to `to`, fading out over ~110ms. */
  tracer(from: THREE.Vector3, to: THREE.Vector3, color: number): void {
    const dir = to.clone().sub(from);
    const len = dir.length();
    if (len < 0.05) return;

    const geo = new THREE.BoxGeometry(0.025, 0.025, len);
    const mat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const beam = new THREE.Mesh(geo, mat);
    beam.position.copy(from).add(dir.multiplyScalar(0.5));
    beam.lookAt(to);
    this.scene.add(beam);
    this.transients.push({ obj: beam, mat, born: performance.now(), ttl: 110 });
  }

  /** Small expanding flash where a shot landed. */
  impact(at: THREE.Vector3, color: number): void {
    const mat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const spark = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 8), mat);
    spark.position.copy(at);
    this.scene.add(spark);
    this.transients.push({ obj: spark, mat, born: performance.now(), ttl: 160, grow: 4 });
  }

  /** Grenade detonation: a bright core flash, an expanding shockwave shell, light. */
  explosion(at: THREE.Vector3): void {
    const core = new THREE.Mesh(
      new THREE.SphereGeometry(0.5, 12, 12),
      new THREE.MeshBasicMaterial({
        color: 0xffd090,
        transparent: true,
        opacity: 0.95,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    core.position.copy(at);
    this.scene.add(core);
    this.transients.push({
      obj: core,
      mat: core.material as THREE.MeshBasicMaterial,
      born: performance.now(),
      ttl: 320,
      grow: 5,
    });

    const shell = new THREE.Mesh(
      new THREE.SphereGeometry(0.6, 16, 16),
      new THREE.MeshBasicMaterial({
        color: 0xff5522,
        transparent: true,
        opacity: 0.5,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        wireframe: true,
      }),
    );
    shell.position.copy(at);
    this.scene.add(shell);
    this.transients.push({
      obj: shell,
      mat: shell.material as THREE.MeshBasicMaterial,
      born: performance.now(),
      ttl: 450,
      grow: 9,
    });

    const light = new THREE.PointLight(0xffaa55, 200, 22, 1.8);
    light.position.copy(at);
    this.scene.add(light);
    const born = performance.now();
    const fade = () => {
      const age = (performance.now() - born) / 350;
      if (age >= 1) {
        this.scene.remove(light);
        return;
      }
      light.intensity = 200 * (1 - age);
      requestAnimationFrame(fade);
    };
    requestAnimationFrame(fade);
  }

  update(now: number): void {
    for (let i = this.transients.length - 1; i >= 0; i--) {
      const t = this.transients[i];
      const age = (now - t.born) / t.ttl;
      if (age >= 1) {
        this.scene.remove(t.obj);
        if (t.obj instanceof THREE.Mesh) t.obj.geometry.dispose();
        t.mat.dispose();
        this.transients.splice(i, 1);
        continue;
      }
      t.mat.opacity = (1 - age) * 0.9;
      if (t.grow) {
        const s = 1 + age * t.grow;
        t.obj.scale.set(s, s, s);
      }
    }
  }
}

/** Live grenades, driven by server state snapshots with local smoothing. */
export class NadeView {
  private scene: THREE.Scene;
  private nades = new Map<number, { group: THREE.Group; target: THREE.Vector3 }>();

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  sync(snapshots: Array<{ id: number; p: [number, number, number] }>): void {
    const seen = new Set<number>();
    for (const snap of snapshots) {
      seen.add(snap.id);
      let nade = this.nades.get(snap.id);
      if (!nade) {
        const group = new THREE.Group();
        const shell = new THREE.Mesh(
          new THREE.SphereGeometry(0.13, 10, 10),
          new THREE.MeshStandardMaterial({ color: 0x1a1e24, roughness: 0.35, metalness: 0.7 }),
        );
        group.add(shell);
        const fuseLight = new THREE.PointLight(0xff4455, 6, 5, 2);
        group.add(fuseLight);
        const band = new THREE.Mesh(
          new THREE.TorusGeometry(0.13, 0.025, 6, 12),
          new THREE.MeshBasicMaterial({ color: 0xff4455 }),
        );
        group.add(band);
        group.position.set(snap.p[0], snap.p[1], snap.p[2]);
        this.scene.add(group);
        nade = { group, target: new THREE.Vector3(snap.p[0], snap.p[1], snap.p[2]) };
        this.nades.set(snap.id, nade);
      }
      nade.target.set(snap.p[0], snap.p[1], snap.p[2]);
    }
    for (const [id, nade] of this.nades) {
      if (!seen.has(id)) this.remove(id, nade);
    }
  }

  /** Snapshots stopped mentioning grenades entirely. */
  clear(): void {
    for (const [id, nade] of this.nades) this.remove(id, nade);
  }

  private remove(id: number, nade: { group: THREE.Group }): void {
    this.scene.remove(nade.group);
    nade.group.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose();
        (obj.material as THREE.Material).dispose();
      }
    });
    this.nades.delete(id);
  }

  update(dt: number, now: number): void {
    const blend = Math.min(1, dt * 14);
    for (const nade of this.nades.values()) {
      nade.group.position.lerp(nade.target, blend);
      nade.group.rotation.x += dt * 6;
      // Blinking fuse, faster as it gets old (clients don't know the fuse —
      // a steady quick blink reads fine).
      const light = nade.group.children[1] as THREE.PointLight;
      light.intensity = Math.sin(now / 60) > 0 ? 7 : 1;
    }
  }
}

import type { WeaponId } from "../shared/constants";

/** Builds the gun meshes for one weapon into `parent`; returns the muzzle z. */
function buildGun(parent: THREE.Group, w: WeaponId): number {
  const dark = new THREE.MeshStandardMaterial({ color: 0x1b2026, roughness: 0.45, metalness: 0.75 });
  const accent = new THREE.MeshStandardMaterial({ color: 0x39424d, roughness: 0.5, metalness: 0.6 });

  if (w === "scrapshot") {
    // Sawn-off scrap cannon: twin fat barrels over a boxy receiver.
    const glow = new THREE.MeshBasicMaterial({ color: 0xff8830 });
    const receiver = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.16, 0.38), dark);
    parent.add(receiver);
    for (const dx of [-0.045, 0.045]) {
      const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.042, 0.05, 0.4, 10), accent);
      barrel.rotation.x = Math.PI / 2;
      barrel.position.set(dx, 0.05, -0.34);
      parent.add(barrel);
    }
    const band = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.1, 0.06), glow);
    band.position.set(0, 0.02, -0.42);
    parent.add(band);
    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.18, 0.1), accent);
    grip.position.set(0, -0.15, 0.1);
    grip.rotation.x = 0.32;
    parent.add(grip);
    return -0.56;
  }

  if (w === "frag") {
    // A frag charge held in the hand: dark sphere, glowing red band, arming pin.
    const glow = new THREE.MeshBasicMaterial({ color: 0xff4455 });
    const shell = new THREE.Mesh(
      new THREE.SphereGeometry(0.09, 12, 12),
      new THREE.MeshStandardMaterial({ color: 0x1a1e24, roughness: 0.35, metalness: 0.7 }),
    );
    shell.position.set(0, -0.04, -0.18);
    parent.add(shell);
    const band = new THREE.Mesh(new THREE.TorusGeometry(0.09, 0.018, 6, 14), glow);
    band.position.copy(shell.position);
    band.rotation.x = Math.PI / 2;
    parent.add(band);
    const pin = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.05, 0.02), accent);
    pin.position.set(0, 0.07, -0.18);
    parent.add(pin);
    const knuckles = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.08, 0.14), dark);
    knuckles.position.set(0, -0.14, -0.1);
    parent.add(knuckles);
    return -0.3;
  }

  if (w === "arcwelder") {
    // Long slim rail with a glowing teal coil stack.
    const glow = new THREE.MeshBasicMaterial({ color: 0x33ffd0 });
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.12, 0.5), dark);
    parent.add(body);
    const rail = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.03, 0.55, 8), accent);
    rail.rotation.x = Math.PI / 2;
    rail.position.set(0, 0.045, -0.45);
    parent.add(rail);
    for (let i = 0; i < 3; i++) {
      const coil = new THREE.Mesh(new THREE.TorusGeometry(0.055, 0.014, 6, 12), glow);
      coil.position.set(0, 0.045, -0.28 - i * 0.13);
      parent.add(coil);
    }
    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.17, 0.09), accent);
    grip.position.set(0, -0.14, 0.12);
    grip.rotation.x = 0.32;
    parent.add(grip);
    return -0.74;
  }

  // Riveter (default): chunky industrial rivet-driver.
  const glow = new THREE.MeshBasicMaterial({ color: 0xff6a22 });
  const receiver = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.16, 0.42), dark);
  parent.add(receiver);
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.045, 0.34, 10), accent);
  barrel.rotation.x = Math.PI / 2;
  barrel.position.set(0, 0.035, -0.34);
  parent.add(barrel);
  const grip = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.18, 0.1), accent);
  grip.position.set(0, -0.15, 0.12);
  grip.rotation.x = 0.32;
  parent.add(grip);
  const sight = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.05, 0.08), dark);
  sight.position.set(0, 0.115, -0.1);
  parent.add(sight);
  const coil = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, 0.16), glow);
  coil.position.set(0, -0.02, -0.3);
  parent.add(coil);
  return -0.54;
}

/** The first-person gun, rebuilt whenever the held weapon changes. */
export class ViewModel {
  readonly group = new THREE.Group();
  private gun = new THREE.Group();
  private current: WeaponId | null = null;
  private readonly muzzleTip = new THREE.Object3D();
  private readonly flash: THREE.PointLight;
  private readonly flashSprite: THREE.Mesh;
  private kick = 0;

  constructor(camera: THREE.Camera) {
    this.group.add(this.gun);
    this.group.add(this.muzzleTip);

    this.flash = new THREE.PointLight(0xffaa55, 0, 6, 2);
    this.group.add(this.flash);

    this.flashSprite = new THREE.Mesh(
      new THREE.SphereGeometry(0.05, 8, 8),
      new THREE.MeshBasicMaterial({
        color: 0xffcc88,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    this.group.add(this.flashSprite);

    this.setWeapon("riveter");
    this.group.position.set(0.26, -0.24, -0.5);
    camera.add(this.group);
  }

  setWeapon(w: WeaponId): void {
    if (w === this.current) return;
    this.current = w;
    this.group.remove(this.gun);
    this.gun.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose();
        (obj.material as THREE.Material).dispose();
      }
    });
    this.gun = new THREE.Group();
    const muzzleZ = buildGun(this.gun, w);
    this.group.add(this.gun);
    this.muzzleTip.position.set(0, 0.035, muzzleZ);
    this.flash.position.copy(this.muzzleTip.position);
    this.flashSprite.position.copy(this.muzzleTip.position);
    this.kick = 0.6; // small draw animation
  }

  shoot(): void {
    this.kick = 1;
    this.flash.intensity = 14;
    (this.flashSprite.material as THREE.MeshBasicMaterial).opacity = 0.9;
    this.flashSprite.scale.set(1 + Math.random(), 1 + Math.random(), 1 + Math.random());
  }

  muzzleWorld(out: THREE.Vector3): THREE.Vector3 {
    return this.muzzleTip.getWorldPosition(out);
  }

  update(dt: number): void {
    this.kick = Math.max(0, this.kick - dt * 9);
    const k = this.kick * this.kick;
    this.group.position.z = -0.5 + k * 0.09;
    this.group.rotation.x = k * 0.14;
    this.flash.intensity = Math.max(0, this.flash.intensity - dt * 140);
    const m = this.flashSprite.material as THREE.MeshBasicMaterial;
    m.opacity = Math.max(0, m.opacity - dt * 9);
  }
}
