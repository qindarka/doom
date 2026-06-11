// Builds the dark-industrial arena from the shared map data, so the rendered
// world is exactly the world the server raycasts against. Also owns the
// jumbotron: a live canvas texture showing the scoreboard, mounted on the
// screen slab above the central bastion.

import * as THREE from "three";

import {
  ARENA_HALF,
  HAZARDS,
  JUMP_PADS,
  OBSTACLES,
  SPAWN_POINTS,
  TELEPORTERS,
  WALLS,
  WALL_HEIGHT,
} from "../shared/map";
import type { AABB } from "../shared/map";
import type { PlayerScore } from "../shared/protocol";
import { crateTexture, floorTexture, monolithTexture, steelTexture, wallTexture } from "./textures";

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
    c.fillStyle = "#171411";
    c.fillRect(0, 0, 512, 256);

    // scanlines
    c.fillStyle = "rgba(0,0,0,0.35)";
    for (let y = 0; y < 256; y += 4) c.fillRect(0, y, 512, 1);

    c.font = "900 30px 'Lucida Console', Monaco, monospace";
    c.fillStyle = "#ffb536";
    c.textAlign = "center";
    c.fillText("FERROFRAG", 256, 38);
    c.strokeStyle = "rgba(255,181,54,0.4)";
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
      c.fillStyle = "#e8ddc8";
      c.textAlign = "right";
      c.fillText(`${p.kills} / ${p.deaths}`, 456, y);
      y += 30;
    }
    if (sorted.length === 0) {
      c.fillStyle = "#8a7240";
      c.textAlign = "center";
      c.fillText("AWAITING OPERATIVES", 256, 130);
    }

    c.font = "700 18px 'Lucida Console', Monaco, monospace";
    c.fillStyle = "#ff9c3f";
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

export function buildScene(): {
  scene: THREE.Scene;
  screen: ScreenBoard;
  tick: (now: number, dt: number) => void;
} {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x9a917e);
  scene.fog = new THREE.FogExp2(0x9a917e, 0.011);
  const animations: Array<(now: number, dt: number) => void> = [];

  // --- Ember sky: a gradient dome (dark zenith, smouldering horizon) ----------
  {
    const skyCanvas = document.createElement("canvas");
    skyCanvas.width = 4;
    skyCanvas.height = 128;
    const c = skyCanvas.getContext("2d");
    if (c) {
      const grad = c.createLinearGradient(0, 0, 0, 128);
      grad.addColorStop(0, "#6e7b88");
      grad.addColorStop(0.55, "#948e80");
      grad.addColorStop(0.85, "#b3a587");
      grad.addColorStop(1, "#c0ad8a");
      c.fillStyle = grad;
      c.fillRect(0, 0, 4, 128);
    }
    const skyTex = new THREE.CanvasTexture(skyCanvas);
    skyTex.colorSpace = THREE.SRGBColorSpace;
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(180, 24, 16),
      new THREE.MeshBasicMaterial({ map: skyTex, side: THREE.BackSide, fog: false }),
    );
    scene.add(sky);
  }

  // --- Drifting ash ------------------------------------------------------------
  {
    const COUNT = 350;
    const positions = new Float32Array(COUNT * 3);
    for (let i = 0; i < COUNT; i++) {
      positions[i * 3] = (Math.random() - 0.5) * ARENA_HALF * 2;
      positions[i * 3 + 1] = Math.random() * 14;
      positions[i * 3 + 2] = (Math.random() - 0.5) * ARENA_HALF * 2;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const ash = new THREE.Points(
      geo,
      new THREE.PointsMaterial({ color: 0xcfc4ad, size: 0.06, transparent: true, opacity: 0.5 }),
    );
    scene.add(ash);
    animations.push((now, dt) => {
      const arr = geo.attributes.position.array as Float32Array;
      for (let i = 0; i < COUNT; i++) {
        arr[i * 3 + 1] -= dt * (0.25 + (i % 5) * 0.08);
        arr[i * 3] += Math.sin(now / 2400 + i) * dt * 0.18;
        if (arr[i * 3 + 1] < 0) arr[i * 3 + 1] = 14;
      }
      geo.attributes.position.needsUpdate = true;
    });
  }

  // --- Lava pools ------------------------------------------------------------------
  {
    const lavaCanvas = document.createElement("canvas");
    lavaCanvas.width = 256;
    lavaCanvas.height = 256;
    const c = lavaCanvas.getContext("2d");
    if (c) {
      c.fillStyle = "#3a0a02";
      c.fillRect(0, 0, 256, 256);
      for (let i = 0; i < 60; i++) {
        const x = Math.random() * 256;
        const y = Math.random() * 256;
        const r = 8 + Math.random() * 30;
        const g = c.createRadialGradient(x, y, 2, x, y, r);
        g.addColorStop(0, "rgba(255,180,40,0.95)");
        g.addColorStop(0.5, "rgba(255,90,10,0.6)");
        g.addColorStop(1, "rgba(80,10,0,0)");
        c.fillStyle = g;
        c.beginPath();
        c.arc(x, y, r, 0, Math.PI * 2);
        c.fill();
      }
    }
    const lavaTex = new THREE.CanvasTexture(lavaCanvas);
    lavaTex.colorSpace = THREE.SRGBColorSpace;
    lavaTex.wrapS = THREE.RepeatWrapping;
    lavaTex.wrapT = THREE.RepeatWrapping;

    for (const pool of HAZARDS) {
      const w = pool.max.x - pool.min.x;
      const d = pool.max.z - pool.min.z;
      const cx = (pool.min.x + pool.max.x) / 2;
      const cz = (pool.min.z + pool.max.z) / 2;
      const mat = new THREE.MeshBasicMaterial({ map: lavaTex });
      const surface = new THREE.Mesh(new THREE.PlaneGeometry(w, d), mat);
      surface.rotation.x = -Math.PI / 2;
      surface.position.set(cx, 0.03, cz);
      scene.add(surface);

      const rim = new THREE.Mesh(
        new THREE.BoxGeometry(w + 0.5, 0.1, d + 0.5),
        new THREE.MeshStandardMaterial({ color: 0x16100c, roughness: 0.9 }),
      );
      rim.position.set(cx, 0.05, cz);
      scene.add(rim);
      // carve the opening illusion: surface sits above the rim plate
      surface.position.y = 0.12;

      const glow = new THREE.PointLight(0xff5510, 40, 18, 1.6);
      glow.position.set(cx, 1.4, cz);
      scene.add(glow);
      animations.push((now) => {
        glow.intensity = 36 + Math.sin(now / 230 + cx) * 7 + Math.sin(now / 97) * 4;
        lavaTex.offset.x = Math.sin(now / 4000) * 0.06;
        lavaTex.offset.y = now / 30000;
      });
    }
  }

  // --- Teleporter pads ---------------------------------------------------------------
  for (const pad of TELEPORTERS) {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.55, 0.95, 28),
      new THREE.MeshBasicMaterial({ color: 0xd9a441, transparent: true, opacity: 0.7, side: THREE.DoubleSide }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(pad.pos.x, 0.03, pad.pos.z);
    scene.add(ring);
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.55, 0.75, 4.5, 16, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0xd9a441,
        transparent: true,
        opacity: 0.1,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    beam.position.set(pad.pos.x, 2.25, pad.pos.z);
    scene.add(beam);
    const light = new THREE.PointLight(0xd9a441, 8, 8, 1.8);
    light.position.set(pad.pos.x, 1.4, pad.pos.z);
    scene.add(light);
    animations.push((now) => {
      ring.rotation.z = now / 900;
      (beam.material as THREE.MeshBasicMaterial).opacity = 0.12 + Math.sin(now / 350) * 0.05;
    });
  }

  // --- Jump pads ------------------------------------------------------------------------
  for (const pad of JUMP_PADS) {
    const plate = new THREE.Mesh(
      new THREE.CylinderGeometry(pad.radius, pad.radius + 0.15, 0.1, 20),
      new THREE.MeshStandardMaterial({ color: 0x1c2128, roughness: 0.5, metalness: 0.6 }),
    );
    plate.position.set(pad.pos.x, 0.05, pad.pos.z);
    scene.add(plate);
    const chevMat = new THREE.MeshBasicMaterial({ color: 0xe6c33c, transparent: true, opacity: 0.85 });
    const chev = new THREE.Mesh(new THREE.ConeGeometry(0.45, 0.5, 4), chevMat);
    chev.position.set(pad.pos.x, 0.45, pad.pos.z);
    scene.add(chev);
    animations.push((now) => {
      chev.position.y = 0.45 + ((now / 600) % 1) * 0.5;
      chevMat.opacity = 0.9 - ((now / 600) % 1) * 0.7;
    });
  }

  // --- Lighting -------------------------------------------------------------
  scene.add(new THREE.HemisphereLight(0xb8bcc2, 0x5e5648, 1.05));

  const sun = new THREE.DirectionalLight(0xfff0da, 2.4);
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


  // --- Floor ------------------------------------------------------------------
  const floorMat = new THREE.MeshStandardMaterial({
    map: floorTexture(ARENA_HALF),
    roughness: 0.92,
    metalness: 0.04,
  });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(ARENA_HALF * 2, ARENA_HALF * 2), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  // --- Boundary walls ------------------------------------------------------------
  const wallMat = new THREE.MeshStandardMaterial({
    map: wallTexture(10, 1.5),
    roughness: 0.9,
    metalness: 0.05,
  });
  for (const wall of WALLS) {
    scene.add(boxMesh(wall, wallMat));
  }

  // Glowing trim along the top of each wall.
  const trimMat = new THREE.MeshStandardMaterial({ color: 0xb3942e, roughness: 0.7, metalness: 0.2 });
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
    roughness: 0.8,
    metalness: 0.15,
  });
  const lowCrateMat = new THREE.MeshStandardMaterial({
    map: crateTexture(),
    color: 0xb9a684,
    roughness: 0.85,
    metalness: 0.1,
  });
  const pillarMat = new THREE.MeshStandardMaterial({
    map: monolithTexture(1.5, 4),
    roughness: 0.85,
    metalness: 0.05,
  });
  const barrierMat = new THREE.MeshStandardMaterial({
    map: monolithTexture(4, 1),
    color: 0xc6c2b6,
    roughness: 0.85,
    metalness: 0.05,
  });
  const monoMat = new THREE.MeshStandardMaterial({
    map: monolithTexture(3, 1.5),
    roughness: 0.85,
    metalness: 0.05,
  });
  const stepMat = new THREE.MeshStandardMaterial({
    map: monolithTexture(1, 0.5),
    color: 0xb5b0a3,
    roughness: 0.85,
    metalness: 0.05,
  });
  const deckMat = new THREE.MeshStandardMaterial({
    map: steelTexture(5, 5),
    roughness: 0.6,
    metalness: 0.6,
  });
  const counterMat = new THREE.MeshStandardMaterial({
    map: steelTexture(4, 1),
    color: 0x9a8f7c,
    roughness: 0.6,
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
        new THREE.MeshStandardMaterial({ color: 0x6e6a5e, roughness: 0.9 }),
      );
      cap.position.set(cx, obstacle.max.y + 0.05, cz);
      scene.add(cap);
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
      const screenGlow = new THREE.PointLight(0xffb536, 10, 16, 1.8);
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
    color: 0xd8d2c2,
    transparent: true,
    opacity: 0.1,
    side: THREE.DoubleSide,
  });
  const padRingMat = new THREE.MeshBasicMaterial({
    color: 0xd8d2c2,
    transparent: true,
    opacity: 0.3,
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

  const tick = (now: number, dt: number): void => {
    for (const fn of animations) fn(now, dt);
  };

  return { scene, screen, tick };
}
