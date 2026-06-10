// Builds the dark-industrial arena from the shared map data, so the rendered
// world is exactly the world the server raycasts against.

import * as THREE from "three";

import { ARENA_HALF, OBSTACLES, SPAWN_POINTS, WALLS, WALL_HEIGHT } from "../shared/map";
import type { AABB } from "../shared/map";
import { crateTexture, floorTexture, monolithTexture, wallTexture } from "./textures";

function boxMesh(aabb: AABB, material: THREE.Material): THREE.Mesh {
  const w = aabb.max.x - aabb.min.x;
  const h = aabb.max.y - aabb.min.y;
  const d = aabb.max.z - aabb.min.z;
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  mesh.position.set(
    (aabb.min.x + aabb.max.x) / 2,
    (aabb.min.y + aabb.max.y) / 2,
    (aabb.min.z + aabb.max.z) / 2,
  );
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

export function buildScene(): THREE.Scene {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x07090d);
  scene.fog = new THREE.FogExp2(0x07090d, 0.016);

  // --- Lighting -------------------------------------------------------------
  scene.add(new THREE.HemisphereLight(0x2c3644, 0x0a0c0e, 0.7));

  const sun = new THREE.DirectionalLight(0xffe8cc, 1.1);
  sun.position.set(30, 42, 18);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -36;
  sun.shadow.camera.right = 36;
  sun.shadow.camera.top = 36;
  sun.shadow.camera.bottom = -36;
  sun.shadow.camera.near = 4;
  sun.shadow.camera.far = 110;
  sun.shadow.bias = -0.0004;
  scene.add(sun);

  // Accent lights: alternating magma / teal around the arena.
  const accents: Array<[number, number, number]> = [
    [-18, -18, 0xff6a22],
    [18, -18, 0x00ffc8],
    [-18, 18, 0x00ffc8],
    [18, 18, 0xff6a22],
    [0, 0, 0xff8844],
  ];
  for (const [x, z, color] of accents) {
    const light = new THREE.PointLight(color, 60, 30, 1.8);
    light.position.set(x, x === 0 && z === 0 ? 7 : 4.5, z);
    scene.add(light);
  }

  // --- Floor ------------------------------------------------------------------
  const floorMat = new THREE.MeshStandardMaterial({
    map: floorTexture(ARENA_HALF),
    roughness: 0.82,
    metalness: 0.38,
  });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(ARENA_HALF * 2, ARENA_HALF * 2), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  // --- Boundary walls ------------------------------------------------------------
  const wallMat = new THREE.MeshStandardMaterial({
    map: wallTexture(10, 1.5),
    roughness: 0.75,
    metalness: 0.3,
  });
  for (const wall of WALLS) {
    scene.add(boxMesh(wall, wallMat));
  }

  // Glowing trim along the top of each wall.
  const trimMat = new THREE.MeshBasicMaterial({ color: 0xff6a22 });
  for (const wall of WALLS) {
    const w = wall.max.x - wall.min.x;
    const d = wall.max.z - wall.min.z;
    const trim = new THREE.Mesh(
      new THREE.BoxGeometry(Math.max(w - 0.2, 0.2), 0.12, Math.max(d - 0.2, 0.2)),
      trimMat,
    );
    trim.position.set(
      (wall.min.x + wall.max.x) / 2,
      WALL_HEIGHT - 0.3,
      (wall.min.z + wall.max.z) / 2,
    );
    // push the trim slightly toward the arena so it is visible from inside
    trim.position.x *= 0.985;
    trim.position.z *= 0.985;
    scene.add(trim);
  }

  // --- Obstacles ---------------------------------------------------------------
  const crateMat = new THREE.MeshStandardMaterial({
    map: crateTexture(),
    color: 0xb9c2cc,
    roughness: 0.7,
    metalness: 0.45,
  });
  const lowCrateMat = new THREE.MeshStandardMaterial({
    map: crateTexture(),
    color: 0xcc9a66,
    roughness: 0.7,
    metalness: 0.35,
  });
  const pillarMat = new THREE.MeshStandardMaterial({
    map: wallTexture(1.5, 4),
    roughness: 0.72,
    metalness: 0.4,
  });
  const barrierMat = new THREE.MeshStandardMaterial({
    map: wallTexture(4, 1),
    color: 0xaab4bf,
    roughness: 0.7,
    metalness: 0.45,
  });
  const monoMat = new THREE.MeshStandardMaterial({
    map: monolithTexture(3, 1.5),
    roughness: 0.6,
    metalness: 0.55,
  });

  for (const obstacle of OBSTACLES) {
    let mat: THREE.Material;
    switch (obstacle.kind) {
      case "monolith":
        mat = monoMat;
        break;
      case "pillar":
        mat = pillarMat;
        break;
      case "barrier":
        mat = barrierMat;
        break;
      case "crate":
        mat = crateMat;
        break;
      case "lowcrate":
        mat = lowCrateMat;
        break;
    }
    scene.add(boxMesh(obstacle, mat));

    // Teal cap-light on the monolith.
    if (obstacle.kind === "monolith") {
      const w = obstacle.max.x - obstacle.min.x;
      const d = obstacle.max.z - obstacle.min.z;
      const cap = new THREE.Mesh(
        new THREE.BoxGeometry(w - 1, 0.1, d - 1),
        new THREE.MeshBasicMaterial({ color: 0x00614c }),
      );
      cap.position.set(
        (obstacle.min.x + obstacle.max.x) / 2,
        obstacle.max.y + 0.05,
        (obstacle.min.z + obstacle.max.z) / 2,
      );
      scene.add(cap);
      const glow = new THREE.PointLight(0x00ffc8, 26, 16, 1.8);
      glow.position.set(cap.position.x, obstacle.max.y + 1.2, cap.position.z);
      scene.add(glow);
    }
  }

  // --- Spawn pads -----------------------------------------------------------------
  const padMat = new THREE.MeshBasicMaterial({
    color: 0x00ffc8,
    transparent: true,
    opacity: 0.18,
    side: THREE.DoubleSide,
  });
  const padRingMat = new THREE.MeshBasicMaterial({
    color: 0x00ffc8,
    transparent: true,
    opacity: 0.45,
    side: THREE.DoubleSide,
  });
  for (const sp of SPAWN_POINTS) {
    const pad = new THREE.Mesh(new THREE.CircleGeometry(0.9, 24), padMat);
    pad.rotation.x = -Math.PI / 2;
    pad.position.set(sp.pos.x, 0.02, sp.pos.z);
    scene.add(pad);
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.82, 0.9, 24), padRingMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(sp.pos.x, 0.025, sp.pos.z);
    scene.add(ring);
  }

  return scene;
}
