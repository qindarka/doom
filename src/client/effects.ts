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

/** The first-person gun: a chunky industrial rivet-driver made of boxes. */
export class ViewModel {
  readonly group = new THREE.Group();
  private readonly muzzleTip = new THREE.Object3D();
  private readonly flash: THREE.PointLight;
  private readonly flashSprite: THREE.Mesh;
  private kick = 0;

  constructor(camera: THREE.Camera) {
    const dark = new THREE.MeshStandardMaterial({ color: 0x1b2026, roughness: 0.45, metalness: 0.75 });
    const accent = new THREE.MeshStandardMaterial({ color: 0x39424d, roughness: 0.5, metalness: 0.6 });
    const glowMat = new THREE.MeshBasicMaterial({ color: 0xff6a22 });

    const receiver = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.16, 0.42), dark);
    this.group.add(receiver);

    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.045, 0.34, 10), accent);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0, 0.035, -0.34);
    this.group.add(barrel);

    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.18, 0.1), accent);
    grip.position.set(0, -0.15, 0.12);
    grip.rotation.x = 0.32;
    this.group.add(grip);

    const sight = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.05, 0.08), dark);
    sight.position.set(0, 0.115, -0.1);
    this.group.add(sight);

    const coil = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, 0.16), glowMat);
    coil.position.set(0, -0.02, -0.3);
    this.group.add(coil);

    this.muzzleTip.position.set(0, 0.035, -0.54);
    this.group.add(this.muzzleTip);

    this.flash = new THREE.PointLight(0xffaa55, 0, 6, 2);
    this.flash.position.copy(this.muzzleTip.position);
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
    this.flashSprite.position.copy(this.muzzleTip.position);
    this.group.add(this.flashSprite);

    this.group.position.set(0.26, -0.24, -0.5);
    camera.add(this.group);
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
