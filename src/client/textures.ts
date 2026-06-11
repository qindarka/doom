// Procedural canvas textures — no external assets, everything is drawn at boot.
// Art direction: a war-worn industrial yard in hazy daylight. Weathered
// concrete, olive-drab ammo crates, rusted steel — grounded, not neon.

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

/** Speckled grime + dust pass shared by all surfaces. */
function grime(ctx: CanvasRenderingContext2D, size: number, amount: number, rng: () => number): void {
  for (let i = 0; i < amount; i++) {
    const x = rng() * size;
    const y = rng() * size;
    const r = rng() * 2.4 + 0.4;
    const dark = rng() > 0.4;
    ctx.fillStyle = dark
      ? `rgba(30,25,18,${0.04 + rng() * 0.1})`
      : `rgba(225,215,195,${0.03 + rng() * 0.05})`;
    ctx.fillRect(x, y, r, r);
  }
}

/** Vertical rust/water streaks dripping from a y position. */
function streaks(
  ctx: CanvasRenderingContext2D,
  size: number,
  count: number,
  rng: () => number,
  color = "110,66,38",
): void {
  for (let i = 0; i < count; i++) {
    const x = rng() * size;
    const y0 = rng() * size * 0.5;
    const len = 30 + rng() * 120;
    const w = 1.5 + rng() * 3;
    const grad = ctx.createLinearGradient(0, y0, 0, y0 + len);
    grad.addColorStop(0, `rgba(${color},${0.25 + rng() * 0.2})`);
    grad.addColorStop(1, `rgba(${color},0)`);
    ctx.fillStyle = grad;
    ctx.fillRect(x, y0, w, len);
  }
}

/** Oil-stained concrete slabs with expansion joints and cracks. */
export function floorTexture(repeats: number): THREE.Texture {
  const size = 512;
  const [canvas, ctx] = makeCanvas(size);
  const rng = mulberry32(101);
  const slab = size / 2;

  ctx.fillStyle = "#7d786c";
  ctx.fillRect(0, 0, size, size);

  for (let py = 0; py < 2; py++) {
    for (let px = 0; px < 2; px++) {
      const x = px * slab;
      const y = py * slab;
      const tone = 116 + Math.floor(rng() * 16);
      ctx.fillStyle = `rgb(${tone},${tone - 5},${tone - 16})`;
      ctx.fillRect(x + 2, y + 2, slab - 4, slab - 4);

      // expansion joints
      ctx.strokeStyle = "rgba(40,36,30,0.8)";
      ctx.lineWidth = 3;
      ctx.strokeRect(x + 2, y + 2, slab - 4, slab - 4);

      // hairline cracks
      for (let c = 0; c < 3; c++) {
        if (rng() > 0.55) continue;
        ctx.strokeStyle = "rgba(50,45,38,0.5)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        let cx = x + rng() * slab;
        let cy = y + rng() * slab;
        ctx.moveTo(cx, cy);
        for (let s = 0; s < 5; s++) {
          cx += (rng() - 0.5) * 60;
          cy += (rng() - 0.5) * 60;
          ctx.lineTo(cx, cy);
        }
        ctx.stroke();
      }
    }
  }

  // oil stains and tire scuffs
  for (let i = 0; i < 9; i++) {
    const x = rng() * size;
    const y = rng() * size;
    const r = 16 + rng() * 46;
    const g = ctx.createRadialGradient(x, y, 2, x, y, r);
    g.addColorStop(0, `rgba(28,25,20,${0.25 + rng() * 0.25})`);
    g.addColorStop(1, "rgba(28,25,20,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  for (let i = 0; i < 5; i++) {
    ctx.strokeStyle = `rgba(35,32,26,${0.12 + rng() * 0.12})`;
    ctx.lineWidth = 5 + rng() * 7;
    ctx.beginPath();
    const y = rng() * size;
    ctx.moveTo(0, y);
    ctx.bezierCurveTo(size * 0.3, y + (rng() - 0.5) * 90, size * 0.7, y + (rng() - 0.5) * 90, size, y + (rng() - 0.5) * 50);
    ctx.stroke();
  }

  grime(ctx, size, 1600, rng);
  return finalize(canvas, repeats, repeats);
}

/** Weathered precast concrete panels with rust streaks and a faded hazard base. */
export function wallTexture(repeatX: number, repeatY: number): THREE.Texture {
  const size = 512;
  const [canvas, ctx] = makeCanvas(size);
  const rng = mulberry32(202);

  ctx.fillStyle = "#8a8478";
  ctx.fillRect(0, 0, size, size);

  // panel grid with formwork seams
  const cols = 4;
  const rows = 2;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = (c * size) / cols;
      const y = (r * size) / rows;
      const tone = 128 + Math.floor(rng() * 18);
      ctx.fillStyle = `rgb(${tone},${tone - 6},${tone - 18})`;
      ctx.fillRect(x + 2, y + 2, size / cols - 4, size / rows - 4);
      ctx.strokeStyle = "rgba(45,40,34,0.7)";
      ctx.lineWidth = 3;
      ctx.strokeRect(x + 2, y + 2, size / cols - 4, size / rows - 4);
      // form-tie holes
      ctx.fillStyle = "rgba(50,44,38,0.8)";
      for (const [hx, hy] of [
        [20, 20],
        [size / cols - 20, 20],
        [20, size / rows - 20],
        [size / cols - 20, size / rows - 20],
      ]) {
        ctx.beginPath();
        ctx.arc(x + hx, y + hy, 4, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  streaks(ctx, size, 16, rng);
  streaks(ctx, size, 10, rng, "60,58,52");

  // faded safety stripe along the base
  const bandH = 46;
  ctx.save();
  ctx.globalAlpha = 0.35;
  ctx.beginPath();
  ctx.rect(0, size - bandH, size, bandH);
  ctx.clip();
  ctx.fillStyle = "#3a382f";
  ctx.fillRect(0, size - bandH, size, bandH);
  ctx.fillStyle = "#c2a23a";
  for (let x = -size; x < size * 2; x += 64) {
    ctx.beginPath();
    ctx.moveTo(x, size);
    ctx.lineTo(x + 32, size - bandH);
    ctx.lineTo(x + 56, size - bandH);
    ctx.lineTo(x + 24, size);
    ctx.fill();
  }
  ctx.restore();

  grime(ctx, size, 1300, rng);
  return finalize(canvas, repeatX, repeatY);
}

/** Olive-drab ammunition crate with stencil markings and edge wear. */
export function crateTexture(): THREE.Texture {
  const size = 256;
  const [canvas, ctx] = makeCanvas(size);
  const rng = mulberry32(303);

  ctx.fillStyle = "#4d5138";
  ctx.fillRect(0, 0, size, size);

  // panel shading + frame
  ctx.fillStyle = "rgba(255,250,230,0.05)";
  ctx.fillRect(8, 8, size - 16, size / 2 - 8);
  ctx.strokeStyle = "rgba(28,30,20,0.9)";
  ctx.lineWidth = 10;
  ctx.strokeRect(5, 5, size - 10, size - 10);
  ctx.strokeStyle = "rgba(28,30,20,0.5)";
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(0, size / 2);
  ctx.lineTo(size, size / 2);
  ctx.stroke();

  // stencil markings
  ctx.fillStyle = "rgba(225,220,200,0.75)";
  ctx.font = "700 26px 'Lucida Console', Monaco, monospace";
  ctx.textAlign = "center";
  ctx.fillText("FERROFRAG", size / 2, size / 2 - 18);
  ctx.font = "700 17px 'Lucida Console', Monaco, monospace";
  ctx.fillText("ORDNANCE  MK-2", size / 2, size / 2 + 28);
  ctx.fillText("HANDLE WITH CARE", size / 2, size / 2 + 54);

  // edge wear: chipped paint showing metal
  for (let i = 0; i < 70; i++) {
    const onEdge = rng() > 0.5;
    const x = onEdge ? (rng() > 0.5 ? rng() * 14 : size - rng() * 14) : rng() * size;
    const y = onEdge ? rng() * size : rng() > 0.5 ? rng() * 14 : size - rng() * 14;
    ctx.fillStyle = `rgba(120,112,95,${0.3 + rng() * 0.4})`;
    ctx.fillRect(x, y, 2 + rng() * 5, 1.5 + rng() * 3);
  }

  grime(ctx, size, 600, rng);
  return finalize(canvas);
}

/** Shuttered bunker concrete (the bastion, barriers). */
export function monolithTexture(repeatX: number, repeatY: number): THREE.Texture {
  const size = 512;
  const [canvas, ctx] = makeCanvas(size);
  const rng = mulberry32(404);

  ctx.fillStyle = "#827d70";
  ctx.fillRect(0, 0, size, size);

  // horizontal formwork board lines
  for (let y = 0; y < size; y += 36) {
    const tone = 122 + Math.floor(rng() * 14);
    ctx.fillStyle = `rgb(${tone},${tone - 6},${tone - 17})`;
    ctx.fillRect(0, y + 2, size, 32);
    ctx.fillStyle = "rgba(48,44,37,0.55)";
    ctx.fillRect(0, y, size, 2.5);
  }

  // patched spalls
  for (let i = 0; i < 6; i++) {
    const x = rng() * size;
    const y = rng() * size;
    const r = 10 + rng() * 26;
    ctx.fillStyle = `rgba(105,98,84,${0.5 + rng() * 0.3})`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  streaks(ctx, size, 14, rng);
  grime(ctx, size, 1100, rng);
  return finalize(canvas, repeatX, repeatY);
}

/** Rusted steel plating (decks, platforms, the shop roof). */
export function steelTexture(repeatX: number, repeatY: number): THREE.Texture {
  const size = 256;
  const [canvas, ctx] = makeCanvas(size);
  const rng = mulberry32(505);

  ctx.fillStyle = "#5a544c";
  ctx.fillRect(0, 0, size, size);

  // plate seams + rivets
  ctx.strokeStyle = "rgba(30,27,23,0.8)";
  ctx.lineWidth = 3;
  ctx.strokeRect(2, 2, size - 4, size - 4);
  ctx.beginPath();
  ctx.moveTo(size / 2, 0);
  ctx.lineTo(size / 2, size);
  ctx.stroke();
  ctx.fillStyle = "rgba(25,22,18,0.9)";
  for (let i = 0; i < 8; i++) {
    ctx.beginPath();
    ctx.arc(10 + (i % 4) * ((size - 20) / 3), i < 4 ? 10 : size - 10, 3.5, 0, Math.PI * 2);
    ctx.fill();
  }

  // rust blooms
  for (let i = 0; i < 14; i++) {
    const x = rng() * size;
    const y = rng() * size;
    const r = 6 + rng() * 26;
    const g = ctx.createRadialGradient(x, y, 1, x, y, r);
    g.addColorStop(0, `rgba(122,70,38,${0.35 + rng() * 0.3})`);
    g.addColorStop(1, "rgba(122,70,38,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  grime(ctx, size, 500, rng);
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
