// Entry point: landing page (display name → Join) that hands off to the Game.

import "./style.css";
import { MAX_PLAYERS } from "../shared/constants";
import { Game } from "./game";

const NAME_KEY = "ferrofrag.name";

const app = document.getElementById("app");
if (!app) throw new Error("#app missing");

// --- Landing overlay -----------------------------------------------------------

const overlay = document.createElement("div");
overlay.className = "overlay";

const title = document.createElement("div");
title.className = "title";
title.append("FERRO");
const titleAccent = document.createElement("span");
titleAccent.textContent = "FRAG";
title.append(titleAccent);

const subtitle = document.createElement("div");
subtitle.className = "subtitle";
subtitle.textContent = "industrial arena combat";

const joinRow = document.createElement("div");
joinRow.className = "join-row";

const nameInput = document.createElement("input");
nameInput.maxLength = 16;
nameInput.placeholder = "CALLSIGN";
nameInput.spellcheck = false;
nameInput.autocomplete = "off";
nameInput.value = localStorage.getItem(NAME_KEY) ?? "";

const joinBtn = document.createElement("button");
joinBtn.textContent = "Deploy";

joinRow.append(nameInput, joinBtn);

const statusLine = document.createElement("div");
statusLine.className = "status-line";

const hint = document.createElement("div");
hint.className = "controls-hint";
const hintLines = [
  ["WASD", "move"],
  ["MOUSE", "aim"],
  ["CLICK", "fire the riveter"],
  ["SPACE", "jump"],
  ["TAB", "scoreboard"],
] as const;
for (const [key, what] of hintLines) {
  const b = document.createElement("b");
  b.textContent = key;
  hint.append(b, ` ${what}`);
  hint.append(document.createElement("br"));
}
if ("ontouchstart" in window) {
  const warn = document.createElement("div");
  warn.style.color = "#ff5533";
  warn.style.marginTop = "10px";
  warn.textContent = "Heads up: Ferrofrag needs a mouse + keyboard.";
  hint.append(warn);
}

overlay.append(title, subtitle, joinRow, statusLine, hint);
app.append(overlay);

// --- Room occupancy on the landing page --------------------------------------------

let statusTimer: number | null = null;

async function refreshStatus(): Promise<void> {
  try {
    const res = await fetch("/api/status");
    if (!res.ok) return;
    const data = (await res.json()) as { players: number; max: number };
    if (!overlay.classList.contains("hidden") && !statusLine.classList.contains("error")) {
      statusLine.textContent =
        data.players > 0
          ? `${data.players}/${data.max} operatives in the arena`
          : "the arena is empty — be the first";
    }
  } catch {
    // Worker not reachable (e.g. vite dev without wrangler); leave the line empty.
  }
}

function startStatusPolling(): void {
  void refreshStatus();
  statusTimer = window.setInterval(() => void refreshStatus(), 5000);
}

function stopStatusPolling(): void {
  if (statusTimer !== null) {
    clearInterval(statusTimer);
    statusTimer = null;
  }
}

startStatusPolling();

// --- Join flow ------------------------------------------------------------------------

let game: Game | null = null;

function join(): void {
  const name = nameInput.value.trim();
  if (!name) {
    statusLine.classList.add("error");
    statusLine.textContent = "enter a callsign first";
    nameInput.focus();
    return;
  }
  if (game) return;

  localStorage.setItem(NAME_KEY, name);
  statusLine.classList.remove("error");
  statusLine.textContent = "connecting…";
  joinBtn.disabled = true;
  nameInput.disabled = true;

  game = new Game(app as HTMLElement, name);

  game.onJoined = () => {
    overlay.classList.add("hidden");
    stopStatusPolling();
  };

  game.onFull = () => {
    overlay.classList.remove("hidden");
    statusLine.classList.add("error");
    statusLine.textContent = `room is full (${MAX_PLAYERS}/${MAX_PLAYERS}) — try again in a minute`;
    joinBtn.disabled = false;
    nameInput.disabled = false;
    joinBtn.textContent = "Retry";
    // The Game instance owns the canvas + sockets; reload for a clean retry.
    joinBtn.onclick = () => location.reload();
  };
}

joinBtn.addEventListener("click", join);
nameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") join();
});
nameInput.focus();
