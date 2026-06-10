// Procedural canvas textures — no external assets, everything is drawn at boot.
// All textures are authored in a grim industrial palette and tinted further by
// material colors where needed.

import * as THREE from "three";

function makeCanvas(size: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas unsupported");
  return [canvas, ctx];
}

function finalize(canvas: HTMLCanvasElement, repeatX = 1, repeatY = 1): THREE.Texture {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeatX, repeatY);
  tex.anisotropy = 4;
  return tex;
}

/** Speckled grime pass shared by all surfaces. */
function grime(ctx: CanvasRenderingContext2D, size: number, amount: number, rng: () => number): void {
  for (let i = 0; i < amount; i++) {
    const x = rng() * size;
    const y = rng() * size;
    const r = rng() * 2.2 + 0.4;
    const dark = rng() > 0.45;
    ctx.fillStyle = dark ? `rgba(0,0,0,${0.05 + rng() * 0.14})` : `rgba(190,205,220,${0.02 + rng() * 0.05})`;
    ctx.fillRect(x, y, r, r);
  }
}

/** Deterministic PRNG so every client draws identical textures. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function floorTexture(repeats: number): THREE.Texture {
  const size = 512;
  const [canvas, ctx] = makeCanvas(size);
  const rng = mulberry32(101);
  const plate = size / 2;

  ctx.fillStyle = "#171b21";
  ctx.fillRect(0, 0, size, size);

  for (let py = 0; py < 2; py++) {
    for (let px = 0; px < 2; px++) {
      const x = px * plate;
      const y = py * plate;
      const shade = 18 + Math.floor(rng() * 14);
      ctx.fillStyle = `rgb(${shade + 4},${shade + 7},${shade + 11})`;
      ctx.fillRect(x + 2, y + 2, plate - 4, plate - 4);

      // plate bevel
      ctx.strokeStyle = "rgba(0,0,0,0.7)";
      ctx.lineWidth = 4;
      ctx.strokeRect(x + 2, y + 2, plate - 4, plate - 4);
      ctx.strokeStyle = "rgba(150,170,190,0.10)";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x + 5, y + 5, plate - 10, plate - 10);

      // rivets in the corners
      ctx.fillStyle = "rgba(8,10,12,0.9)";
      for (const [rx, ry] of [
        [14, 14],
        [plate - 14, 14],
        [14, plate - 14],
        [plate - 14, plate - 14],
      ]) {
        ctx.beginPath();
        ctx.arc(x + rx, y + ry, 5, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = "rgba(170,190,210,0.18)";
      for (const [rx, ry] of [
        [14, 14],
        [plate - 14, 14],
        [14, plate - 14],
        [plate - 14, plate - 14],
      ]) {
        ctx.beginPath();
        ctx.arc(x + rx - 1, y + ry - 1, 2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  grime(ctx, size, 1400, rng);
  return finalize(canvas, repeats, repeats);
}

export function wallTexture(repeatX: number, repeatY: number): THREE.Texture {
  const size = 512;
  const [canvas, ctx] = makeCanvas(size);
  const rng = mulberry32(202);

  ctx.fillStyle = "#1c2127";
  ctx.fillRect(0, 0, size, size);

  // vertical panel ribs
  const ribs = 8;
  for (let i = 0; i < ribs; i++) {
    const x = (i * size) / ribs;
    const shade = 22 + Math.floor(rng() * 10);
    ctx.fillStyle = `rgb(${shade + 4},${shade + 8},${shade + 13})`;
    ctx.fillRect(x + 3, 0, size / ribs - 6, size);
    ctx.fillStyle = "rgba(0,0,0,0.65)";
    ctx.fillRect(x, 0, 3, size);
    ctx.fillStyle = "rgba(150,170,190,0.07)";
    ctx.fillRect(x + 3, 0, 2, size);
  }

  // hazard band along the bottom (sits at the wall base in world space)
  const bandH = 56;
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, size - bandH, size, bandH);
  ctx.clip();
  ctx.fillStyle = "#0d0f12";
  ctx.fillRect(0, size - bandH, size, bandH);
  ctx.fillStyle = "rgba(255,106,34,0.55)";
  for (let x = -size; x < size * 2; x += 64) {
    ctx.beginPath();
    ctx.moveTo(x, size);
    ctx.lineTo(x + 32, size - bandH);
    ctx.lineTo(x + 56, size - bandH);
    ctx.lineTo(x + 24, size);
    ctx.fill();
  }
  ctx.restore();
  ctx.fillStyle = "rgba(0,0,0,0.5)";
  ctx.fillRect(0, size - bandH - 3, size, 3);

  grime(ctx, size, 1100, rng);
  return finalize(canvas, repeatX, repeatY);
}

export function crateTexture(): THREE.Texture {
  const size = 256;
  const [canvas, ctx] = makeCanvas(size);
  const rng = mulberry32(303);

  ctx.fillStyle = "#232930";
  ctx.fillRect(0, 0, size, size);

  // edge frame
  ctx.strokeStyle = "#11151a";
  ctx.lineWidth = 18;
  ctx.strokeRect(9, 9, size - 18, size - 18);
  ctx.strokeStyle = "rgba(160,180,200,0.10)";
  ctx.lineWidth = 3;
  ctx.strokeRect(20, 20, size - 40, size - 40);

  // X brace
  ctx.strokeStyle = "rgba(10,12,15,0.85)";
  ctx.lineWidth = 14;
  ctx.beginPath();
  ctx.moveTo(24, 24);
  ctx.lineTo(size - 24, size - 24);
  ctx.moveTo(size - 24, 24);
  ctx.lineTo(24, size - 24);
  ctx.stroke();
  ctx.strokeStyle = "rgba(190,205,220,0.08)";
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(24, 24);
  ctx.lineTo(size - 24, size - 24);
  ctx.moveTo(size - 24, 24);
  ctx.lineTo(24, size - 24);
  ctx.stroke();

  grime(ctx, size, 500, rng);
  return finalize(canvas);
}

export function monolithTexture(repeatX: number, repeatY: number): THREE.Texture {
  const size = 512;
  const [canvas, ctx] = makeCanvas(size);
  const rng = mulberry32(404);

  ctx.fillStyle = "#15181d";
  ctx.fillRect(0, 0, size, size);

  // large brushed panels
  for (let y = 0; y < 2; y++) {
    for (let x = 0; x < 2; x++) {
      const shade = 16 + Math.floor(rng() * 8);
      ctx.fillStyle = `rgb(${shade + 3},${shade + 6},${shade + 10})`;
      ctx.fillRect(x * 256 + 4, y * 256 + 4, 248, 248);
      ctx.strokeStyle = "rgba(0,0,0,0.8)";
      ctx.lineWidth = 5;
      ctx.strokeRect(x * 256 + 4, y * 256 + 4, 248, 248);
    }
  }

  // teal status slits
  ctx.fillStyle = "rgba(0,255,200,0.5)";
  ctx.fillRect(40, 116, 110, 5);
  ctx.fillRect(330, 372, 110, 5);
  ctx.fillStyle = "rgba(0,255,200,0.16)";
  ctx.fillRect(36, 110, 118, 17);
  ctx.fillRect(326, 366, 118, 17);

  grime(ctx, size, 900, rng);
  return finalize(canvas, repeatX, repeatY);
}

/** Name tag rendered to a sprite texture. */
export function nameTexture(name: string, colorHex: number): THREE.Texture {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 128;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas unsupported");

  const color = `#${colorHex.toString(16).padStart(6, "0")}`;
  ctx.font = "900 56px 'Lucida Console', Monaco, monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.shadowColor = "rgba(0,0,0,0.95)";
  ctx.shadowBlur = 10;
  ctx.lineWidth = 8;
  ctx.strokeStyle = "rgba(0,0,0,0.9)";
  ctx.strokeText(name, 256, 64);
  ctx.shadowBlur = 0;
  ctx.fillStyle = color;
  ctx.fillText(name, 256, 64);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
