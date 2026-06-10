#!/usr/bin/env node
// Browser-level verification: boots `wrangler dev`, joins two headless Chromium
// pages as separate players, and checks the landing flow, HUD, roster sync and
// that the WebGL scene actually renders (screenshots land in /tmp).
//
// Requires playwright (not a project dependency):  npm i --no-save playwright
// Then: node scripts/render-test.mjs

import { spawn } from "node:child_process";
import process from "node:process";
import { chromium } from "playwright";

const PORT = 8801;
const BASE = `http://127.0.0.1:${PORT}`;

const failures = [];
let passes = 0;
function ok(cond, label) {
  if (cond) {
    passes++;
    console.log(`  ✓ ${label}`);
  } else {
    failures.push(label);
    console.error(`  ✗ ${label}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForServer() {
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`${BASE}/api/status`)).ok) return;
    } catch {
      /* not yet */
    }
    await sleep(500);
  }
  throw new Error("wrangler dev never became ready");
}

async function joinAs(browser, name, errors) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(`${name}: ${msg.text()}`);
  });
  page.on("pageerror", (err) => errors.push(`${name}: ${err.message}`));
  await page.goto(BASE);
  await page.fill(".join-row input", name);
  await page.click(".join-row button");
  await page.waitForSelector("#hud.active", { timeout: 10000 });
  return page;
}

async function main() {
  const wrangler = spawn("npx", ["wrangler", "dev", "--port", String(PORT)], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  const cleanup = () => {
    try {
      process.kill(-wrangler.pid, "SIGTERM");
    } catch {
      /* gone */
    }
  };
  process.on("exit", cleanup);

  let browser = null;
  try {
    await waitForServer();
    console.log("server ready; launching chromium");
    browser = await chromium.launch({
      executablePath: process.env.CHROME_PATH || undefined,
      args: ["--use-gl=angle", "--use-angle=swiftshader-webgl", "--enable-unsafe-swiftshader", "--no-sandbox"],
    });

    const errors = [];

    // Landing page renders.
    const probe = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await probe.goto(BASE);
    ok((await probe.textContent(".title")) === "FERROFRAG", "landing page shows the title");
    await probe.screenshot({ path: "/tmp/ferrofrag-landing.png" });
    await probe.close();

    // Two players join and see each other in the roster.
    const alpha = await joinAs(browser, "Alpha", errors);
    ok(true, "Alpha joins and the HUD activates");
    const bravo = await joinAs(browser, "Bravo", errors);
    ok(true, "Bravo joins and the HUD activates");

    await sleep(1500); // a few state ticks + roster broadcasts

    const counts = await alpha.textContent(".topbar");
    ok(counts?.includes("2"), `Alpha's topbar shows 2 operatives (${counts?.trim()})`);

    // Scoreboard lists both names (Tab held).
    await alpha.keyboard.down("Tab");
    await sleep(200);
    const board = await alpha.textContent(".scoreboard");
    ok(board?.includes("Alpha") && board?.includes("Bravo"), "scoreboard lists both players");
    await alpha.keyboard.up("Tab");

    // The WebGL canvas actually drew something non-black.
    const shot = await alpha.screenshot({ path: "/tmp/ferrofrag-ingame.png" });
    const lit = await alpha.evaluate(() => {
      const canvas = document.querySelector("#app canvas");
      const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
      if (!gl) return -1;
      const px = new Uint8Array(4 * 64);
      gl.readPixels(
        Math.floor(gl.drawingBufferWidth / 2) - 32,
        Math.floor(gl.drawingBufferHeight / 2),
        64,
        1,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        px,
      );
      let sum = 0;
      for (let i = 0; i < px.length; i += 4) sum += px[i] + px[i + 1] + px[i + 2];
      return sum;
    });
    ok(shot.length > 20000, `in-game screenshot is non-trivial (${shot.length} bytes)`);
    console.log(`  (center-row brightness sample: ${lit})`);

    // Free up CPU before the practice page: SwiftShader renders on the CPU and
    // three live WebGL pages starve each other.
    await alpha.close();
    await bravo.close();

    // Practice mode: join a bot arena and capture the troopers.
    const hermit = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    hermit.on("console", (msg) => {
      if (msg.type() === "error") errors.push(`hermit: ${msg.text()}`);
    });
    hermit.on("pageerror", (err) => errors.push(`hermit: ${err.message}`));
    await hermit.goto(BASE);
    await hermit.fill(".join-row input", "Hermit");
    await hermit.click(".overlay .practice");
    await hermit.waitForSelector("#hud.active", { timeout: 20000 });
    const practiceCount = await hermit.textContent(".topbar");
    ok(practiceCount?.includes("4"), `practice topbar shows 4 operatives (${practiceCount?.trim()})`);
    await sleep(10000); // bots hunt the idle player; one usually walks into view
    await hermit.screenshot({ path: "/tmp/ferrofrag-practice.png" });
    await hermit.close();

    const benign = /Autoplay|preload|favicon|SwiftShader|GroupMarkerNotSet|GPU stall/i;
    const realErrors = errors.filter((e) => !benign.test(e));
    ok(realErrors.length === 0, `no console errors (${realErrors.length}: ${realErrors.slice(0, 3).join(" | ")})`);
  } catch (err) {
    failures.push(String(err.message ?? err));
    console.error(`FATAL: ${err.message ?? err}`);
  } finally {
    await browser?.close();
    cleanup();
  }

  console.log(`\n${passes} passed, ${failures.length} failed`);
  console.log("screenshots: /tmp/ferrofrag-landing.png /tmp/ferrofrag-ingame.png");
  if (failures.length) process.exit(1);
}

main();
