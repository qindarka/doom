// DOM-based HUD: crisp text, zero WebGL cost. All player-provided strings are
// set via textContent (never innerHTML), so names can't inject markup.

import { DEFAULT_WEAPON, MAX_HEALTH, MAX_PLAYERS, WEAPONS } from "../shared/constants";
import type { WeaponId } from "../shared/constants";
import type { PlayerScore } from "../shared/protocol";

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  parent?: HTMLElement,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  parent?.appendChild(node);
  return node;
}

function colorOf(hex: number): string {
  return `#${hex.toString(16).padStart(6, "0")}`;
}

export class Hud {
  private root: HTMLElement;
  private hud: HTMLElement;
  private healthPanel!: HTMLElement;
  private healthNum: HTMLElement;
  private healthFill: HTMLElement;
  private healthStatus!: HTMLElement;
  private lowhp!: HTMLElement;
  private weaponName!: HTMLElement;
  private weaponAmmo!: HTMLElement;
  private toastTimer = 0;
  private playersEl: HTMLElement;
  private pingEl: HTMLElement;
  private killfeed: HTMLElement;
  private scoreboard: HTMLElement;
  private scoreboardBody: HTMLElement;
  private deathScreen: HTMLElement;
  private deathBy: HTMLElement;
  private deathCount: HTMLElement;
  private vignette: HTMLElement;
  private hitmarker: HTMLElement;
  private toast: HTMLElement;
  private pauseHint: HTMLElement;
  private hitmarkerTimer = 0;
  private vignetteTimer = 0;

  constructor(parent: HTMLElement) {
    this.root = parent;
    this.hud = el("div", "", this.root);
    this.hud.id = "hud";

    el("div", "crosshair", this.hud);
    this.hitmarker = el("div", "hitmarker", this.hud);
    this.lowhp = el("div", "lowhp", this.hud);
    this.vignette = el("div", "vignette", this.hud);

    this.healthPanel = el("div", "health-panel", this.hud);
    const labelRow = el("div", "health-label", this.healthPanel);
    labelRow.textContent = "INTEGRITY";
    this.healthStatus = el("span", "health-status", labelRow);
    const healthRow = el("div", "health-row", this.healthPanel);
    this.healthNum = el("div", "health-num", healthRow);
    const bar = el("div", "health-bar", healthRow);
    this.healthFill = el("div", "", bar);

    const weaponPanel = el("div", "weapon-panel", this.hud);
    this.weaponName = el("div", "weapon-name", weaponPanel);
    this.weaponAmmo = el("div", "weapon-ammo", weaponPanel);
    this.setWeapon(DEFAULT_WEAPON, null);

    const topbar = el("div", "topbar", this.hud);
    this.playersEl = el("span", "", topbar);
    this.pingEl = el("span", "", topbar);

    this.killfeed = el("div", "killfeed", this.hud);

    this.scoreboard = el("div", "scoreboard", this.hud);
    el("h2", "", this.scoreboard).textContent = "Scoreboard";
    const table = el("table", "", this.scoreboard);
    const thead = el("thead", "", table);
    const headRow = el("tr", "", thead);
    for (const [label, cls] of [
      ["PLAYER", ""],
      ["KILLS", "num"],
      ["DEATHS", "num"],
    ] as const) {
      const th = el("th", cls, headRow);
      th.textContent = label;
    }
    this.scoreboardBody = el("tbody", "", table);

    this.deathScreen = el("div", "death-screen", this.hud);
    el("div", "death-title", this.deathScreen).textContent = "FRAGGED";
    this.deathBy = el("div", "death-by", this.deathScreen);
    this.deathCount = el("div", "death-count", this.deathScreen);

    this.toast = el("div", "toast", this.hud);
    this.pauseHint = el("div", "pause-hint", this.hud);
    this.pauseHint.textContent = "CLICK TO RESUME";

    el("div", "bottom-hint", this.hud).textContent =
      "WASD MOVE · SPACE JUMP · CLICK SHOOT · 1-4 WEAPONS · CTRL CYCLE · TAB SCORES · M MUSIC";

    this.setHealth(MAX_HEALTH);
    this.setPlayers(1);
    this.setPing(0);
  }

  show(): void {
    this.hud.classList.add("active");
  }

  hide(): void {
    this.hud.classList.remove("active");
  }

  setHealth(hp: number): void {
    const clamped = Math.max(0, Math.round(hp));
    this.healthNum.textContent = String(clamped);
    this.healthNum.classList.toggle("low", clamped <= 30);
    this.healthFill.style.width = `${(clamped / MAX_HEALTH) * 100}%`;

    // Tiered readout: color, status word, and a closing-in red vignette that
    // makes "how close to death am I" legible without looking at the numbers.
    const tier = clamped > 60 ? "ok" : clamped > 30 ? "warn" : "crit";
    this.healthPanel.classList.toggle("warn", tier === "warn");
    this.healthPanel.classList.toggle("crit", tier === "crit");
    this.healthStatus.textContent =
      tier === "ok" ? "OPTIMAL" : tier === "warn" ? "DAMAGED" : "CRITICAL";
    const danger = Math.max(0, (60 - clamped) / 60);
    this.lowhp.style.opacity = String(danger * 0.75);
    this.lowhp.classList.toggle("pulse", tier === "crit" && clamped > 0);
  }

  setPlayers(n: number): void {
    this.playersEl.textContent = "";
    const b = document.createElement("b");
    b.textContent = String(n);
    this.playersEl.append("OPERATIVES ", b, ` / ${MAX_PLAYERS}`);
  }

  setPing(ms: number): void {
    this.pingEl.textContent = "";
    const b = document.createElement("b");
    b.textContent = String(ms);
    this.pingEl.append("PING ", b, " MS");
  }

  flashHitmarker(): void {
    this.hitmarker.classList.add("show");
    window.clearTimeout(this.hitmarkerTimer);
    this.hitmarkerTimer = window.setTimeout(() => this.hitmarker.classList.remove("show"), 70);
  }

  flashDamage(): void {
    this.vignette.classList.add("show");
    window.clearTimeout(this.vignetteTimer);
    this.vignetteTimer = window.setTimeout(() => this.vignette.classList.remove("show"), 120);
  }

  addKill(killer: PlayerScore | undefined, victim: PlayerScore | undefined): void {
    const entry = el("div", "entry");
    const k = document.createElement("span");
    k.textContent = killer?.name ?? "???";
    k.style.color = killer ? colorOf(killer.color) : "#888";
    const skull = document.createElement("span");
    skull.className = "skull";
    skull.textContent = "⚔";
    const v = document.createElement("span");
    v.textContent = victim?.name ?? "???";
    v.style.color = victim ? colorOf(victim.color) : "#888";
    entry.append(k, skull, v);
    this.killfeed.prepend(entry);

    while (this.killfeed.children.length > 5) {
      this.killfeed.lastChild?.remove();
    }
    window.setTimeout(() => entry.classList.add("fade"), 4200);
    window.setTimeout(() => entry.remove(), 4900);
  }

  showScoreboard(show: boolean): void {
    this.scoreboard.classList.toggle("show", show);
  }

  updateScoreboard(roster: PlayerScore[], myId: string): void {
    const sorted = [...roster].sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
    this.scoreboardBody.textContent = "";
    for (const p of sorted) {
      const tr = document.createElement("tr");
      if (p.id === myId) tr.className = "me";

      const nameTd = document.createElement("td");
      const dot = document.createElement("span");
      dot.className = "dot";
      dot.style.background = colorOf(p.color);
      nameTd.append(dot, document.createTextNode(p.name));

      const killsTd = document.createElement("td");
      killsTd.className = "num";
      killsTd.textContent = String(p.kills);

      const deathsTd = document.createElement("td");
      deathsTd.className = "num";
      deathsTd.textContent = String(p.deaths);

      tr.append(nameTd, killsTd, deathsTd);
      this.scoreboardBody.appendChild(tr);
    }
  }

  showDeath(killerName: string): void {
    this.deathBy.textContent = `terminated by ${killerName}`;
    this.deathScreen.classList.add("show");
  }

  setDeathCountdown(seconds: number): void {
    this.deathCount.textContent =
      seconds > 0 ? `redeploying in ${seconds.toFixed(1)}s` : "redeploying…";
  }

  hideDeath(): void {
    this.deathScreen.classList.remove("show");
  }

  setWeapon(w: WeaponId, ammo: number | null): void {
    this.weaponName.textContent = WEAPONS[w].name.toUpperCase();
    this.weaponAmmo.textContent = ammo === null ? "HITSCAN · ∞" : `AMMO · ${ammo}`;
    this.weaponAmmo.style.color = ammo !== null && ammo <= 2 ? "#ff5533" : "";
  }

  showToast(text: string): void {
    window.clearTimeout(this.toastTimer);
    this.toast.textContent = text;
    this.toast.classList.add("show");
  }

  /** A toast that hides itself (pickups, music toggle). */
  flashToast(text: string, ms = 1800): void {
    this.showToast(text);
    this.toastTimer = window.setTimeout(() => this.hideToast(), ms);
  }

  hideToast(): void {
    this.toast.classList.remove("show");
  }

  showPauseHint(show: boolean): void {
    this.pauseHint.classList.toggle("show", show);
  }
}
