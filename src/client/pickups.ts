// Floating weapon pickups: a glowing pad plus a slowly spinning, bobbing
// miniature of the weapon. Availability is driven entirely by server events.

import * as THREE from "three";

import { WEAPONS } from "../shared/constants";
import type { WeaponId } from "../shared/constants";
import { ITEM_SPAWNS } from "../shared/map";
import type { ItemSpawn } from "../shared/map";

const HEALTH_COLOR = 0x44ff77;

/** A medkit: dark case with a glowing cross. */
function miniKit(): THREE.Group {
  const group = new THREE.Group();
  const caseMat = new THREE.MeshStandardMaterial({ color: 0x2a3138, roughness: 0.45, metalness: 0.5 });
  const cross = new THREE.MeshBasicMaterial({ color: HEALTH_COLOR });
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.3, 0.42), caseMat);
  group.add(body);
  const barV = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.02, 0.3), cross);
  barV.position.y = 0.16;
  group.add(barV);
  const barH = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.02, 0.09), cross);
  barH.position.y = 0.16;
  group.add(barH);
  return group;
}

function miniGun(w: WeaponId): THREE.Group {
  const group = new THREE.Group();
  const dark = new THREE.MeshStandardMaterial({ color: 0x222831, roughness: 0.4, metalness: 0.7 });
  const glow = new THREE.MeshBasicMaterial({ color: WEAPONS[w].color });

  if (w === "frag") {
    const shell = new THREE.Mesh(new THREE.SphereGeometry(0.16, 12, 12), dark);
    group.add(shell);
    const band = new THREE.Mesh(new THREE.TorusGeometry(0.16, 0.03, 6, 14), glow);
    band.rotation.x = Math.PI / 2;
    group.add(band);
    const shell2 = shell.clone();
    shell2.position.set(0.3, -0.05, 0.1);
    shell2.scale.setScalar(0.8);
    group.add(shell2);
    return group;
  }

  if (w === "scrapshot") {
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.2, 0.55), dark);
    group.add(body);
    for (const dx of [-0.06, 0.06]) {
      const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 0.5, 8), dark);
      barrel.rotation.x = Math.PI / 2;
      barrel.position.set(dx, 0.07, -0.4);
      group.add(barrel);
    }
    const band = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.12, 0.08), glow);
    band.position.set(0, 0.03, -0.5);
    group.add(band);
  } else {
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.16, 0.6), dark);
    group.add(body);
    const rail = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.04, 0.65, 8), dark);
    rail.rotation.x = Math.PI / 2;
    rail.position.set(0, 0.06, -0.5);
    group.add(rail);
    for (let i = 0; i < 3; i++) {
      const coil = new THREE.Mesh(new THREE.TorusGeometry(0.07, 0.018, 6, 12), glow);
      coil.position.set(0, 0.06, -0.3 - i * 0.16);
      group.add(coil);
    }
  }
  return group;
}

interface PickupNode {
  root: THREE.Group;
  ring: THREE.Mesh;
  light: THREE.PointLight;
  avail: boolean;
  phase: number;
}

export class Pickups {
  private nodes = new Map<number, PickupNode>();

  constructor(scene: THREE.Scene) {
    for (const spawn of ITEM_SPAWNS as ItemSpawn[]) {
      const root = new THREE.Group();
      root.position.set(spawn.pos.x, spawn.pos.y, spawn.pos.z);

      const item = spawn.kind === "health" ? miniKit() : miniGun(spawn.weapon ?? "scrapshot");
      item.scale.setScalar(1.15);
      root.add(item);

      const color = spawn.kind === "health" ? HEALTH_COLOR : WEAPONS[spawn.weapon ?? "scrapshot"].color;
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.45, 0.6, 24),
        new THREE.MeshBasicMaterial({
          color,
          transparent: true,
          opacity: 0.55,
          side: THREE.DoubleSide,
        }),
      );
      // Every item floats 0.35m above its supporting surface; the ring sits on it.
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = -0.34;
      root.add(ring);

      const light = new THREE.PointLight(color, 7, 6, 2);
      root.add(light);

      scene.add(root);
      this.nodes.set(spawn.id, {
        root,
        ring,
        light,
        avail: true,
        phase: spawn.id * 1.7,
      });
    }
  }

  setAvail(id: number, avail: boolean): void {
    const node = this.nodes.get(id);
    if (node) node.avail = avail;
  }

  setAll(states: Array<{ id: number; avail: boolean }>): void {
    for (const s of states) this.setAvail(s.id, s.avail);
  }

  update(now: number): void {
    const t = now / 1000;
    for (const node of this.nodes.values()) {
      node.root.visible = node.avail;
      if (!node.avail) {
        node.light.intensity = 0;
        continue;
      }
      node.root.rotation.y = t * 1.4 + node.phase;
      node.root.children[0].position.y = Math.sin(t * 2.2 + node.phase) * 0.07;
      node.light.intensity = 6 + Math.sin(t * 3 + node.phase) * 1.5;
    }
  }
}
