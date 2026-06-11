// Horde monster rendering: procedural bodies per kind, driven by the same
// snapshot-buffer interpolation as remote players.

import * as THREE from "three";

import { INTERP_DELAY_MS } from "../shared/constants";
import type { MonsterSnapshot } from "../shared/protocol";

interface Snap {
  t: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpAngle(a: number, b: number, t: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

function buildBody(kind: MonsterSnapshot["k"]): THREE.Group {
  const group = new THREE.Group();
  const hide = new THREE.MeshStandardMaterial({ color: 0x2b2420, roughness: 0.75, metalness: 0.35 });

  if (kind === "fiend") {
    // A low scuttling scrap-beast: wedge body, spike ridge, burning eyes.
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.55, 1.2), hide);
    body.position.y = 0.45;
    body.castShadow = true;
    group.add(body);
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.4, 0.5), hide);
    head.position.set(0, 0.6, -0.75);
    head.castShadow = true;
    group.add(head);
    const eyes = new THREE.Mesh(
      new THREE.BoxGeometry(0.4, 0.08, 0.05),
      new THREE.MeshBasicMaterial({ color: 0xff3311 }),
    );
    eyes.position.set(0, 0.65, -1.0);
    group.add(eyes);
    for (let i = 0; i < 3; i++) {
      const spike = new THREE.Mesh(
        new THREE.ConeGeometry(0.1, 0.35, 5),
        new THREE.MeshStandardMaterial({ color: 0x44372c, roughness: 0.6, metalness: 0.5 }),
      );
      spike.position.set(0, 0.8, -0.3 + i * 0.35);
      group.add(spike);
    }
    for (const sx of [-0.45, 0.45]) {
      for (const sz of [-0.4, 0.4]) {
        const leg = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.45, 0.14), hide);
        leg.position.set(sx, 0.22, sz);
        group.add(leg);
      }
    }
    return group;
  }

  if (kind === "drone") {
    // A hovering welder: sphere core, rotor ring, under-glow.
    const core = new THREE.Mesh(
      new THREE.SphereGeometry(0.32, 14, 12),
      new THREE.MeshStandardMaterial({ color: 0x3a4250, roughness: 0.4, metalness: 0.7 }),
    );
    core.castShadow = true;
    group.add(core);
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.45, 0.05, 8, 20),
      new THREE.MeshStandardMaterial({ color: 0x222831, roughness: 0.5, metalness: 0.7 }),
    );
    ring.rotation.x = Math.PI / 2;
    group.add(ring);
    const eyeGlow = new THREE.Mesh(
      new THREE.SphereGeometry(0.1, 8, 8),
      new THREE.MeshBasicMaterial({ color: 0xffb536 }),
    );
    eyeGlow.position.set(0, -0.05, -0.3);
    group.add(eyeGlow);
    const light = new THREE.PointLight(0xffb536, 4, 6, 2);
    light.position.y = -0.3;
    group.add(light);
    return group;
  }

  // The Foundry Warden: hulking biped with a molten core.
  const torso = new THREE.Mesh(new THREE.BoxGeometry(1.5, 1.3, 0.9), hide);
  torso.position.y = 1.6;
  torso.castShadow = true;
  group.add(torso);
  const core = new THREE.Mesh(
    new THREE.BoxGeometry(0.5, 0.5, 0.1),
    new THREE.MeshBasicMaterial({ color: 0xff7722 }),
  );
  core.position.set(0, 1.7, -0.48);
  group.add(core);
  const coreLight = new THREE.PointLight(0xff7722, 12, 8, 2);
  coreLight.position.set(0, 1.7, -0.6);
  group.add(coreLight);
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.45, 0.55), hide);
  head.position.set(0, 2.45, -0.1);
  head.castShadow = true;
  group.add(head);
  const eyes = new THREE.Mesh(
    new THREE.BoxGeometry(0.35, 0.07, 0.05),
    new THREE.MeshBasicMaterial({ color: 0xff3311 }),
  );
  eyes.position.set(0, 2.48, -0.4);
  group.add(eyes);
  for (const sx of [-0.95, 0.95]) {
    const shoulder = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.5, 0.6), hide);
    shoulder.position.set(sx, 2.1, 0);
    shoulder.castShadow = true;
    group.add(shoulder);
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.32, 1.1, 0.35), hide);
    arm.position.set(sx, 1.3, 0);
    group.add(arm);
  }
  for (const sx of [-0.4, 0.4]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.42, 1.0, 0.5), hide);
    leg.position.set(sx, 0.5, 0);
    group.add(leg);
  }
  return group;
}

interface MonsterNode {
  group: THREE.Group;
  kind: MonsterSnapshot["k"];
  buffer: Snap[];
  hp: number;
  mh: number;
}

export class MonsterView {
  private scene: THREE.Scene;
  private nodes = new Map<number, MonsterNode>();

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  sync(snaps: MonsterSnapshot[], now: number): void {
    const seen = new Set<number>();
    for (const snap of snaps) {
      seen.add(snap.id);
      let node = this.nodes.get(snap.id);
      if (!node) {
        const group = buildBody(snap.k);
        group.position.set(snap.p[0], snap.p[1], snap.p[2]);
        this.scene.add(group);
        node = { group, kind: snap.k, buffer: [], hp: snap.hp, mh: snap.mh };
        this.nodes.set(snap.id, node);
      }
      node.hp = snap.hp;
      node.mh = snap.mh;
      node.buffer.push({ t: now, x: snap.p[0], y: snap.p[1], z: snap.p[2], yaw: snap.yaw });
      while (node.buffer.length > 2 && node.buffer[0].t < now - 1200) node.buffer.shift();
    }
    for (const [id, node] of this.nodes) {
      if (!seen.has(id)) this.remove(id, node);
    }
  }

  /** Position lookup for death-gib placement. */
  positionOf(id: number): THREE.Vector3 | null {
    const node = this.nodes.get(id);
    return node ? node.group.position.clone() : null;
  }

  /** The live warden (boss bar), if any. */
  warden(): { hp: number; mh: number } | null {
    for (const node of this.nodes.values()) {
      if (node.kind === "warden") return { hp: node.hp, mh: node.mh };
    }
    return null;
  }

  count(): number {
    return this.nodes.size;
  }

  private remove(id: number, node: MonsterNode): void {
    this.scene.remove(node.group);
    node.group.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose();
        (obj.material as THREE.Material).dispose();
      }
    });
    this.nodes.delete(id);
  }

  clear(): void {
    for (const [id, node] of this.nodes) this.remove(id, node);
  }

  update(now: number): void {
    const renderTime = now - INTERP_DELAY_MS;
    for (const node of this.nodes.values()) {
      const buf = node.buffer;
      if (buf.length === 0) continue;
      let x = buf[buf.length - 1].x;
      let y = buf[buf.length - 1].y;
      let z = buf[buf.length - 1].z;
      let yaw = buf[buf.length - 1].yaw;
      if (buf.length > 1 && renderTime < buf[buf.length - 1].t) {
        let i = buf.length - 2;
        while (i > 0 && buf[i].t > renderTime) i--;
        const a = buf[i];
        const b = buf[i + 1];
        const span = Math.max(b.t - a.t, 1);
        const t = Math.min(1, Math.max(0, (renderTime - a.t) / span));
        x = lerp(a.x, b.x, t);
        y = lerp(a.y, b.y, t);
        z = lerp(a.z, b.z, t);
        yaw = lerpAngle(a.yaw, b.yaw, t);
      }
      node.group.position.set(x, y, z);
      node.group.rotation.y = yaw;
      // Idle motion: fiends skitter-bob, drones hover-sway, the warden looms.
      if (node.kind === "drone") {
        node.group.position.y = y + Math.sin(now / 400 + node.group.id) * 0.15;
        node.group.rotation.z = Math.sin(now / 600) * 0.08;
      } else if (node.kind === "fiend") {
        node.group.position.y = y + Math.abs(Math.sin(now / 110)) * 0.05;
      }
    }
  }
}
