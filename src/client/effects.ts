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

interface Gib {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  spin: THREE.Vector3;
  born: number;
}

export class Effects {
  private scene: THREE.Scene;
  private transients: Transient[] = [];
  private gibList: Gib[] = [];
  private lastUpdate = 0;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  /** Death burst: armor chunks and bolts that bounce on the floor and fade. */
  gibs(at: THREE.Vector3, color: number): void {
    const now = performance.now();
    const armorMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(color).multiplyScalar(0.85),
      roughness: 0.5,
      metalness: 0.5,
      transparent: true,
    });
    const suitMat = new THREE.MeshStandardMaterial({
      color: 0x1c2128,
      roughness: 0.7,
      metalness: 0.4,
      transparent: true,
    });
    for (let i = 0; i < 11; i++) {
      const s = 0.08 + Math.random() * 0.16;
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(s, s * (0.5 + Math.random()), s),
        (i % 3 === 0 ? suitMat : armorMat).clone(),
      );
      mesh.position.set(at.x, at.y + 0.6 + Math.random() * 0.8, at.z);
      this.scene.add(mesh);
      this.gibList.push({
        mesh,
        vel: new THREE.Vector3(
          (Math.random() - 0.5) * 7,
          2.5 + Math.random() * 5,
          (Math.random() - 0.5) * 7,
        ),
        spin: new THREE.Vector3(Math.random() * 10, Math.random() * 10, Math.random() * 10),
        born: now,
      });
    }
    armorMat.dispose();
    suitMat.dispose();
  }

  /** Teleporter departure/arrival flash. */
  /** Warden slam telegraph: a pulsing red danger ring on the ground. */
  slamWarning(at: THREE.Vector3, msUntilImpact: number): void {
    const mat = new THREE.MeshBasicMaterial({
      color: 0xff2200,
      transparent: true,
      opacity: 0.55,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const ring = new THREE.Mesh(new THREE.RingGeometry(3.6, 5, 36), mat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(at.x, 0.06, at.z);
    this.scene.add(ring);
    this.transients.push({ obj: ring, mat, born: performance.now(), ttl: msUntilImpact + 250 });
  }

  teleportFlash(at: THREE.Vector3): void {
    const mat = new THREE.MeshBasicMaterial({
      color: 0xbb88ff,
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const column = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 2.4, 14, 1, true), mat);
    column.position.set(at.x, at.y + 1.2, at.z);
    this.scene.add(column);
    this.transients.push({ obj: column, mat, born: performance.now(), ttl: 380, grow: 1.6 });
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
    const dt = Math.min(0.05, this.lastUpdate ? (now - this.lastUpdate) / 1000 : 0.016);
    this.lastUpdate = now;

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

    const GIB_TTL = 1600;
    for (let i = this.gibList.length - 1; i >= 0; i--) {
      const g = this.gibList[i];
      const age = now - g.born;
      if (age >= GIB_TTL) {
        this.scene.remove(g.mesh);
        g.mesh.geometry.dispose();
        (g.mesh.material as THREE.Material).dispose();
        this.gibList.splice(i, 1);
        continue;
      }
      g.vel.y -= 20 * dt;
      g.mesh.position.addScaledVector(g.vel, dt);
      if (g.mesh.position.y < 0.06) {
        g.mesh.position.y = 0.06;
        g.vel.y = Math.abs(g.vel.y) > 1 ? -g.vel.y * 0.4 : 0;
        g.vel.x *= 0.7;
        g.vel.z *= 0.7;
      }
      g.mesh.rotation.x += g.spin.x * dt;
      g.mesh.rotation.y += g.spin.y * dt;
      g.mesh.rotation.z += g.spin.z * dt;
      (g.mesh.material as THREE.MeshStandardMaterial).opacity = Math.min(1, (GIB_TTL - age) / 500);
    }
  }
}

/** Live grenades, driven by server state snapshots with local smoothing. */
export class NadeView {
  private scene: THREE.Scene;
  private nades = new Map<number, { group: THREE.Group; target: THREE.Vector3; rocket: boolean }>();

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  sync(snapshots: Array<{ id: number; k?: "f" | "r" | "b"; p: [number, number, number] }>): void {
    const seen = new Set<number>();
    for (const snap of snapshots) {
      seen.add(snap.id);
      let nade = this.nades.get(snap.id);
      if (!nade) {
        const group = new THREE.Group();
        if (snap.k === "b") {
          // Drone bolt: a hot teal plasma blob.
          const blob = new THREE.Mesh(
            new THREE.SphereGeometry(0.12, 8, 8),
            new THREE.MeshBasicMaterial({
              color: 0x55ffee,
              transparent: true,
              opacity: 0.95,
              blending: THREE.AdditiveBlending,
              depthWrite: false,
            }),
          );
          group.add(blob);
          group.add(new THREE.PointLight(0x33ddff, 8, 6, 2));
        } else if (snap.k === "r") {
          // Rocket: dark dart with a hot exhaust glow (oriented in update()).
          const body = new THREE.Mesh(
            new THREE.ConeGeometry(0.09, 0.45, 10),
            new THREE.MeshStandardMaterial({ color: 0x1a1e24, roughness: 0.35, metalness: 0.7 }),
          );
          body.rotation.x = Math.PI / 2; // cone tip toward -z... oriented via lookAt below
          group.add(body);
          const exhaust = new THREE.Mesh(
            new THREE.SphereGeometry(0.09, 8, 8),
            new THREE.MeshBasicMaterial({
              color: 0xffaa44,
              transparent: true,
              opacity: 0.9,
              blending: THREE.AdditiveBlending,
              depthWrite: false,
            }),
          );
          exhaust.position.z = -0.28;
          group.add(exhaust);
          const fire = new THREE.PointLight(0xff7722, 10, 7, 2);
          group.add(fire);
        } else {
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
        }
        group.position.set(snap.p[0], snap.p[1], snap.p[2]);
        this.scene.add(group);
        nade = {
          group,
          target: new THREE.Vector3(snap.p[0], snap.p[1], snap.p[2]),
          rocket: snap.k === "r" || snap.k === "b",
        };
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
      if (nade.rocket) {
        // Point the dart along its motion.
        if (nade.group.position.distanceToSquared(nade.target) > 0.0004) {
          nade.group.lookAt(nade.target);
        }
        nade.group.position.lerp(nade.target, Math.min(1, dt * 22));
        continue;
      }
      nade.group.position.lerp(nade.target, blend);
      nade.group.rotation.x += dt * 6;
      // Blinking fuse — clients don't know the fuse; a steady quick blink reads fine.
      const light = nade.group.children[1] as THREE.PointLight;
      light.intensity = Math.sin(now / 60) > 0 ? 7 : 1;
    }
  }
}

import type { WeaponId } from "../shared/constants";

/** Builds the gun meshes for one weapon into `parent`; returns the muzzle z. */
function buildGun(parent: THREE.Group, w: WeaponId): number {
  const gunmetal = new THREE.MeshStandardMaterial({ color: 0x23262b, roughness: 0.45, metalness: 0.7 });
  const polymer = new THREE.MeshStandardMaterial({ color: 0x32332d, roughness: 0.8, metalness: 0.1 });
  const wood = new THREE.MeshStandardMaterial({ color: 0x5b4630, roughness: 0.75, metalness: 0.05 });

  const box = (mat: THREE.Material, wd: number, h: number, d: number, x: number, y: number, z: number): void => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(wd, h, d), mat);
    m.position.set(x, y, z);
    parent.add(m);
  };
  const cyl = (mat: THREE.Material, r: number, len: number, x: number, y: number, z: number): void => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 10), mat);
    m.rotation.x = Math.PI / 2;
    m.position.set(x, y, z);
    parent.add(m);
  };

  if (w === "scrapshot") {
    // Pump shotgun: long barrel over a tube magazine, wooden pump and stock.
    box(gunmetal, 0.1, 0.13, 0.3, 0, 0, 0.02); // receiver
    cyl(gunmetal, 0.028, 0.52, 0, 0.045, -0.34); // barrel
    cyl(gunmetal, 0.022, 0.44, 0, -0.02, -0.3); // tube mag
    box(wood, 0.09, 0.07, 0.16, 0, -0.02, -0.32); // pump
    box(wood, 0.09, 0.13, 0.18, 0, -0.05, 0.2); // stock
    box(gunmetal, 0.02, 0.03, 0.03, 0, 0.11, -0.55); // bead sight
    return -0.62;
  }

  if (w === "arcwelder") {
    // Marksman rifle: long slim barrel, boxy receiver, scope tube.
    box(gunmetal, 0.09, 0.13, 0.4, 0, 0, 0.02); // receiver
    cyl(gunmetal, 0.022, 0.62, 0, 0.03, -0.48); // barrel
    cyl(gunmetal, 0.04, 0.2, 0, 0.13, -0.05); // scope
    box(gunmetal, 0.02, 0.05, 0.02, 0, 0.09, -0.05); // scope mount
    box(polymer, 0.08, 0.1, 0.22, 0, -0.03, -0.28); // forend
    box(polymer, 0.08, 0.13, 0.2, 0, -0.06, 0.24); // stock
    box(polymer, 0.08, 0.16, 0.09, 0, -0.13, 0.08); // grip
    return -0.79;
  }

  if (w === "frag") {
    // Frag grenade in a gloved hand: olive canister with a steel spoon.
    const olive = new THREE.MeshStandardMaterial({ color: 0x44492f, roughness: 0.8, metalness: 0.1 });
    const shell = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.16, 12), olive);
    shell.position.set(0, -0.04, -0.18);
    parent.add(shell);
    const capMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.04, 8), gunmetal);
    capMesh.position.set(0, 0.06, -0.18);
    parent.add(capMesh);
    box(gunmetal, 0.02, 0.1, 0.04, 0.05, 0.02, -0.18); // spoon lever
    box(polymer, 0.1, 0.08, 0.14, 0, -0.14, -0.1); // glove knuckles
    return -0.3;
  }

  if (w === "lance") {
    // Shoulder rocket tube, olive drab with a blast ring.
    const olive = new THREE.MeshStandardMaterial({ color: 0x474c33, roughness: 0.75, metalness: 0.15 });
    cyl(olive, 0.075, 0.62, 0, 0.02, -0.32);
    cyl(gunmetal, 0.082, 0.06, 0, 0.02, -0.62); // muzzle ring
    cyl(gunmetal, 0.082, 0.06, 0, 0.02, 0.0); // breech ring
    box(gunmetal, 0.04, 0.07, 0.12, 0, 0.13, -0.2); // sight block
    box(polymer, 0.08, 0.16, 0.09, 0, -0.12, -0.05); // grip
    return -0.66;
  }

  if (w === "smelter") {
    // The Smelter: an industrial heat cannon — triple barrel cluster, and the
    // one glow we keep: a furnace ring that says DANGER.
    const glow = new THREE.MeshBasicMaterial({ color: 0xff9c3f });
    box(gunmetal, 0.2, 0.2, 0.5, 0, 0, 0.05); // housing
    cyl(gunmetal, 0.045, 0.5, 0, 0.06, -0.42);
    cyl(gunmetal, 0.045, 0.5, -0.055, -0.03, -0.42);
    cyl(gunmetal, 0.045, 0.5, 0.055, -0.03, -0.42);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.1, 0.018, 6, 16), glow);
    ring.position.set(0, 0.01, -0.3);
    parent.add(ring);
    box(polymer, 0.1, 0.18, 0.1, 0, -0.17, 0.12); // grip
    return -0.72;
  }

  // Riveter (default): a workhorse carbine — receiver, handguard, mag, stock.
  box(gunmetal, 0.09, 0.13, 0.36, 0, 0, 0); // receiver
  cyl(gunmetal, 0.024, 0.3, 0, 0.035, -0.4); // barrel
  box(polymer, 0.085, 0.09, 0.24, 0, -0.005, -0.26); // handguard
  box(gunmetal, 0.06, 0.18, 0.09, 0, -0.13, -0.04); // curved magazine
  box(polymer, 0.08, 0.15, 0.08, 0, -0.12, 0.12); // grip
  box(polymer, 0.075, 0.11, 0.2, 0, -0.03, 0.26); // stock
  box(gunmetal, 0.02, 0.05, 0.02, 0, 0.1, -0.5); // front post
  box(gunmetal, 0.04, 0.04, 0.04, 0, 0.085, 0.08); // rear sight
  return -0.56;
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
