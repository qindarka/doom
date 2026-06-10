// Builds the dark-industrial arena from the shared map data, so the rendered
// world is exactly the world the server raycasts against. Also owns the
// jumbotron: a live canvas texture showing the scoreboard, mounted on the
// screen slab above the central bastion.

import * as THREE from "three";

import { ARENA_HALF, OBSTACLES, SPAWN_POINTS, WALLS, WALL_HEIGHT } from "../shared/map";
import type { AABB } from "../shared/map";
import type { PlayerScore } from "../shared/protocol";
import { crateTexture, floorTexture, monolithTexture, wallTexture } from "./textures";

/** The live scoreboard screen drawn onto the jumbotron slab. */
export class ScreenBoard {
  readonly texture: THREE.CanvasTexture;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private feedLine = "WELCOME TO THE ARENA";

  constructor() {
    this.canvas = document.createElement("canvas");
    this.canvas.width = 512;
    this.canvas.height = 256;
    const ctx = this.canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas unsupported");
    this.ctx = ctx;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.update([], null);
  }

  update(roster: PlayerScore[], feedLine: string | null): void {
    if (feedLine) this.feedLine = feedLine.toUpperCase();
    const c = this.ctx;
    c.fillStyle = "#021410";
    c.fillRect(0, 0, 512, 256);

    // scanlines
    c.fillStyle = "rgba(0,0,0,0.35)";
    for (let y = 0; y < 256; y += 4) c.fillRect(0, y, 512, 1);

    c.font = "900 30px 'Lucida Console', Monaco, monospace";
    c.fillStyle = "#33ffd0";
    c.textAlign = "center";
    c.fillText("FERROFRAG", 256, 38);
    c.strokeStyle = "rgba(51,255,208,0.4)";
    c.lineWidth = 2;
    c.beginPath();
    c.moveTo(40, 52);
    c.lineTo(472, 52);
    c.stroke();

    const sorted = [...roster].sort((a, b) => b.kills - a.kills || a.deaths - b.deaths).slice(0, 5);
    c.font = "700 22px 'Lucida Console', Monaco, monospace";
    let y = 86;
    for (const p of sorted) {
      c.fillStyle = `#${p.color.toString(16).padStart(6, "0")}`;
      c.textAlign = "left";
      c.fillText(p.name.slice(0, 12), 56, y);
      c.fillStyle = "#bfe8dd";
      c.textAlign = "right";
      c.fillText(`${p.kills} / ${p.deaths}`, 456, y);
      y += 30;
    }
    if (sorted.length === 0) {
      c.fillStyle = "#1c7a64";
      c.textAlign = "center";
      c.fillText("AWAITING OPERATIVES", 256, 130);
    }

    c.font = "700 18px 'Lucida Console', Monaco, monospace";
    c.fillStyle = "#ff8844";
    c.textAlign = "center";
    c.fillText(this.feedLine.slice(0, 40), 256, 240);

    this.texture.needsUpdate = true;
  }
}

/** "ARMORY" sign texture for the shop roof front. */
function armorySignTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 64;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas unsupported");
  ctx.fillStyle = "#0c0e11";
  ctx.fillRect(0, 0, 512, 64);
  ctx.font = "900 44px 'Lucida Console', Monaco, monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.shadowColor = "#ff6a22";
  ctx.shadowBlur = 18;
  ctx.fillStyle = "#ffa050";
  ctx.fillText("◆ ARMORY ◆", 256, 34);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

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

export function buildScene(): { scene: THREE.Scene; screen: ScreenBoard } {
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
  const stepMat = new THREE.MeshStandardMaterial({
    map: monolithTexture(1, 0.5),
    color: 0xb9c4cf,
    roughness: 0.65,
    metalness: 0.5,
  });
  const deckMat = new THREE.MeshStandardMaterial({
    map: wallTexture(5, 0.5),
    color: 0xc4ccd4,
    roughness: 0.6,
    metalness: 0.55,
  });
  const counterMat = new THREE.MeshStandardMaterial({
    map: monolithTexture(2, 0.5),
    color: 0xd0b890,
    roughness: 0.55,
    metalness: 0.5,
  });
  const screenFrameMat = new THREE.MeshStandardMaterial({
    color: 0x0a0d11,
    roughness: 0.4,
    metalness: 0.8,
  });

  const screen = new ScreenBoard();

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
      case "step":
        mat = stepMat;
        break;
      case "deck":
      case "roof":
        mat = deckMat;
        break;
      case "counter":
        mat = counterMat;
        break;
      case "screen":
        mat = screenFrameMat;
        break;
    }
    scene.add(boxMesh(obstacle, mat));

    const cx = (obstacle.min.x + obstacle.max.x) / 2;
    const cz = (obstacle.min.z + obstacle.max.z) / 2;
    const w = obstacle.max.x - obstacle.min.x;
    const h = obstacle.max.y - obstacle.min.y;
    const d = obstacle.max.z - obstacle.min.z;

    // Teal cap-light on the bastion.
    if (obstacle.kind === "monolith") {
      const cap = new THREE.Mesh(
        new THREE.BoxGeometry(w - 1, 0.1, d - 1),
        new THREE.MeshBasicMaterial({ color: 0x00614c }),
      );
      cap.position.set(cx, obstacle.max.y + 0.05, cz);
      scene.add(cap);
      const glow = new THREE.PointLight(0x00ffc8, 26, 16, 1.8);
      glow.position.set(cx, obstacle.max.y + 1.2, cz);
      scene.add(glow);
    }

    // The jumbotron: live scoreboard faces on both sides of the screen slab.
    if (obstacle.kind === "screen") {
      const faceMat = new THREE.MeshBasicMaterial({ map: screen.texture });
      const south = new THREE.Mesh(new THREE.PlaneGeometry(w - 0.5, h - 0.4), faceMat);
      south.position.set(cx, obstacle.min.y + h / 2, obstacle.max.z + 0.02);
      scene.add(south);
      const north = new THREE.Mesh(new THREE.PlaneGeometry(w - 0.5, h - 0.4), faceMat);
      north.position.set(cx, obstacle.min.y + h / 2, obstacle.min.z - 0.02);
      north.rotation.y = Math.PI;
      scene.add(north);
      const screenGlow = new THREE.PointLight(0x33ffd0, 18, 18, 1.8);
      screenGlow.position.set(cx, obstacle.min.y - 0.5, cz);
      scene.add(screenGlow);
    }

    // The Armory sign on the shop roof's front edge.
    if (obstacle.kind === "roof") {
      const sign = new THREE.Mesh(
        new THREE.PlaneGeometry(6, 0.75),
        new THREE.MeshBasicMaterial({ map: armorySignTexture(), transparent: true }),
      );
      sign.position.set(cx, obstacle.min.y + 0.1, obstacle.max.z + 0.03);
      scene.add(sign);
      const signGlow = new THREE.PointLight(0xff8844, 14, 12, 1.8);
      signGlow.position.set(cx, obstacle.min.y - 0.8, obstacle.max.z + 1.5);
      scene.add(signGlow);
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

  return { scene, screen };
}
