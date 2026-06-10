// Game orchestration: owns the renderer, wires net messages to simulation and
// presentation, and runs the frame/input loops.

import * as THREE from "three";

import {
  DEFAULT_WEAPON,
  INPUT_MS,
  MAX_HEALTH,
  RESPAWN_DELAY_MS,
  WEAPONS,
} from "../shared/constants";
import type { WeaponId } from "../shared/constants";
import { SOLIDS } from "../shared/map";
import { perturbDir, playerAABB, rayAABB, rayAABBs, vec3 } from "../shared/math";
import type { PlayerScore, ServerMsg } from "../shared/protocol";
import { Sfx } from "./audio";
import { Effects, NadeView, ViewModel } from "./effects";
import { Hud } from "./hud";
import { Input } from "./input";
import type { Music } from "./music";
import { Net } from "./net";
import { Pickups } from "./pickups";
import { LocalPlayer } from "./player";
import { Remotes } from "./remotes";
import { buildScene, type ScreenBoard } from "./scene";

const TOKEN_KEY = "ferrofrag.token";

const WEAPON_SLOTS: Record<string, WeaponId> = {
  Digit1: "riveter",
  Digit2: "scrapshot",
  Digit3: "arcwelder",
  Digit4: "frag",
};

/** Ctrl (either side, any OS) cycles through owned weapons in this order. */
const CYCLE_ORDER: WeaponId[] = ["riveter", "scrapshot", "arcwelder", "frag"];

export class Game {
  onJoined: () => void = () => {};
  onFull: () => void = () => {};

  private renderer: THREE.WebGLRenderer;
  private camera: THREE.PerspectiveCamera;
  private scene: THREE.Scene;
  private screen: ScreenBoard;
  private hud: Hud;
  private input = new Input();
  private sfx = new Sfx();
  private music: Music;
  private net: Net;
  private local = new LocalPlayer();
  private remotes: Remotes;
  private effects: Effects;
  private viewModel: ViewModel;
  private pickups: Pickups;
  private nadeView: NadeView;

  private myId = "";
  private roster = new Map<string, PlayerScore>();
  private rosterArr: PlayerScore[] = [];
  private hp = MAX_HEALTH;
  private weapon: WeaponId = DEFAULT_WEAPON;
  private ammo: Partial<Record<WeaponId, number>> = {};
  private playing = false;
  private deathUntil = 0;
  private lastShotAt = -Infinity;
  private lastFrame = performance.now();
  private inputTimer: number | null = null;
  private shake = 0;
  private lastHeartbeat = 0;

  constructor(root: HTMLElement, name: string, room: string | null, music: Music) {
    this.music = music;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    root.appendChild(this.renderer.domElement);

    const built = buildScene();
    this.scene = built.scene;
    this.screen = built.screen;
    this.camera = new THREE.PerspectiveCamera(
      75,
      window.innerWidth / window.innerHeight,
      0.1,
      250,
    );
    this.camera.rotation.order = "YXZ";
    this.scene.add(this.camera); // so view-model children render

    this.remotes = new Remotes(this.scene);
    this.effects = new Effects(this.scene);
    this.viewModel = new ViewModel(this.camera);
    this.pickups = new Pickups(this.scene);
    this.nadeView = new NadeView(this.scene);
    this.hud = new Hud(root);

    this.input.attach(this.renderer.domElement);
    this.input.onLockChange = (locked) => {
      this.hud.showPauseHint(this.playing && !locked && !this.local.dead);
    };
    this.renderer.domElement.addEventListener("click", () => {
      this.sfx.unlock();
      if (this.playing && !this.input.locked) this.input.requestLock();
    });
    document.addEventListener("keydown", () => this.sfx.unlock(), { once: true });

    window.addEventListener("resize", () => {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(window.innerWidth, window.innerHeight);
    });

    this.net = new Net(name, room ? null : localStorage.getItem(TOKEN_KEY), room);
    this.net.onMessage = (msg) => this.handleMessage(msg);
    this.net.onStatus = (status) => {
      if (status === "reconnecting") {
        this.hud.showToast("RECONNECTING…");
      } else if (status === "open") {
        this.hud.hideToast();
      } else if (status === "full") {
        this.onFull();
      } else if (status === "replaced") {
        this.hud.showToast("SESSION TAKEN OVER IN ANOTHER TAB — REFRESH TO REJOIN");
        document.exitPointerLock();
      } else if (status === "outdated") {
        this.hud.showToast("NEW VERSION DEPLOYED — REFRESH THE PAGE TO REJOIN");
        document.exitPointerLock();
      }
    };

    this.net.connect();
    requestAnimationFrame((t) => this.frame(t));
  }

  // --- Server messages -----------------------------------------------------------

  private handleMessage(msg: ServerMsg): void {
    const now = performance.now();
    switch (msg.type) {
      case "welcome": {
        this.myId = msg.id;
        localStorage.setItem(TOKEN_KEY, msg.token);
        this.local.spawn(msg.spawn, msg.yaw, msg.e);
        this.hp = msg.hp;
        this.hud.setHealth(this.hp);
        this.setRoster(msg.roster);
        this.pickups.setAll(msg.items);
        this.setWeapon(DEFAULT_WEAPON, true);
        this.ammo = {};
        if (!this.playing) {
          this.playing = true;
          this.hud.show();
          this.startInputLoop();
          this.onJoined();
        }
        if (this.hp <= 0) {
          // Reconnected while dead; hold the death screen until the server's
          // spawn message arrives (the respawn timer kept running server-side).
          this.local.dead = true;
          this.deathUntil = now;
          this.hud.showDeath("the void");
        } else {
          this.hud.hideDeath();
        }
        break;
      }

      case "roster":
        this.setRoster(msg.players);
        break;

      case "state": {
        this.remotes.onState(msg.players, this.myId, now);
        this.nadeView.sync(msg.nades ?? []);
        const me = msg.players.find((p) => p.id === this.myId);
        if (me && me.hp !== this.hp) {
          this.hp = me.hp;
          this.hud.setHealth(this.hp);
        }
        break;
      }

      case "shot": {
        if (msg.id === this.myId) break; // own shots are predicted locally
        const origin = new THREE.Vector3(msg.o[0], msg.o[1], msg.o[2]);
        const start = this.remotes.muzzleOf(msg.id) ?? origin;
        const color = WEAPONS[msg.w].color;
        for (const ray of msg.rays) {
          const end = new THREE.Vector3(
            msg.o[0] + ray.d[0] * ray.t,
            msg.o[1] + ray.d[1] * ray.t,
            msg.o[2] + ray.d[2] * ray.t,
          );
          this.effects.tracer(start, end, color);
          if (!ray.hitId) this.effects.impact(end, color);
        }

        // Positional-ish audio: pan by the shooter's side, fade by distance.
        const toShooter = origin.clone().sub(this.camera.position);
        const distance = toShooter.length();
        const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
        const pan = Math.max(-0.9, Math.min(0.9, right.dot(toShooter.normalize())));
        const vol = Math.max(0.1, Math.min(1, 1 - distance / 45));
        this.sfx.shootRemote(pan, vol);
        break;
      }

      case "item":
        this.pickups.setAvail(msg.id, msg.avail);
        break;

      case "pickup":
        this.ammo[msg.w] = msg.ammo;
        this.setWeapon(msg.w, true);
        this.sfx.pickup();
        this.hud.flashToast(`${WEAPONS[msg.w].name.toUpperCase()} ACQUIRED`);
        break;

      case "heal":
        this.hp = msg.hp;
        this.hud.setHealth(this.hp);
        this.sfx.heal();
        this.hud.flashToast("INTEGRITY RESTORED");
        break;

      case "boom": {
        const at = new THREE.Vector3(msg.p[0], msg.p[1], msg.p[2]);
        this.effects.explosion(at);
        const toBlast = at.clone().sub(this.camera.position);
        const distance = toBlast.length();
        const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
        const pan = Math.max(-0.9, Math.min(0.9, right.dot(toBlast.normalize())));
        this.sfx.explosion(pan, Math.max(0.15, Math.min(1, 1 - distance / 55)));
        if (distance < 16) this.shake = Math.max(this.shake, 1.3 - distance / 16);
        break;
      }

      case "hit":
        if (msg.id === this.myId) {
          this.hp = msg.hp;
          this.hud.setHealth(this.hp);
          this.hud.flashDamage();
          this.sfx.hurt();
          this.shake = 1;
        }
        if (msg.by === this.myId) {
          this.hud.flashHitmarker();
          this.sfx.hitConfirm();
        }
        break;

      case "death": {
        const killer = this.roster.get(msg.by);
        const victim = this.roster.get(msg.id);
        this.hud.addKill(killer, victim);
        this.screen.update(this.rosterArr, `${killer?.name ?? "???"} ⚔ ${victim?.name ?? "???"}`);
        if (msg.id === this.myId) {
          this.local.dead = true;
          this.deathUntil = now + RESPAWN_DELAY_MS;
          this.hp = 0;
          this.hud.setHealth(0);
          this.hud.showDeath(killer?.name ?? "???");
          this.sfx.death();
          // Pickups are dropped on death.
          this.ammo = {};
          this.setWeapon(DEFAULT_WEAPON, true);
        } else if (msg.by === this.myId) {
          this.sfx.killConfirm();
        }
        break;
      }

      case "spawn":
        if (msg.id === this.myId) {
          this.local.spawn(msg.p, msg.yaw, msg.e);
          this.hp = msg.hp;
          this.hud.setHealth(this.hp);
          this.hud.hideDeath();
          this.sfx.respawn();
        } else {
          this.remotes.teleport(msg.id, msg.p, msg.yaw, now);
        }
        break;

      case "pong":
        this.net.notePong(msg.t);
        this.hud.setPing(this.net.ping);
        break;

      case "error":
        this.hud.showToast(msg.reason.toUpperCase());
        break;

      case "full":
        // Net handles status; the landing page shows the message.
        break;
    }
  }

  private setRoster(roster: PlayerScore[]): void {
    this.roster = new Map(roster.map((p) => [p.id, p]));
    this.rosterArr = roster;
    this.remotes.sync(roster, this.myId);
    this.hud.updateScoreboard(roster, this.myId);
    this.hud.setPlayers(roster.length);
    this.screen.update(roster, null);
  }

  // --- Weapons -----------------------------------------------------------------------

  private setWeapon(w: WeaponId, force = false): void {
    if (!force && w === this.weapon) return;
    if (!force && w !== DEFAULT_WEAPON && (this.ammo[w] ?? 0) <= 0) return;
    const changed = w !== this.weapon;
    this.weapon = w;
    this.viewModel.setWeapon(w);
    this.hud.setWeapon(w, WEAPONS[w].ammo === null ? null : (this.ammo[w] ?? 0));
    if (changed && !force) this.sfx.weaponSwitch();
  }

  /** Ctrl: advance to the next weapon you actually own ammo for. */
  private cycleWeapon(): void {
    const start = CYCLE_ORDER.indexOf(this.weapon);
    for (let step = 1; step <= CYCLE_ORDER.length; step++) {
      const w = CYCLE_ORDER[(start + step) % CYCLE_ORDER.length];
      if (w === DEFAULT_WEAPON || (this.ammo[w] ?? 0) > 0) {
        this.setWeapon(w);
        return;
      }
    }
  }

  // --- Shooting ----------------------------------------------------------------------

  private tryFire(now: number): void {
    const def = WEAPONS[this.weapon];
    if (now - this.lastShotAt < def.cooldownMs) return;
    if (def.ammo !== null && (this.ammo[this.weapon] ?? 0) <= 0) {
      this.setWeapon(DEFAULT_WEAPON);
      return;
    }
    this.lastShotAt = now;

    const origin = this.local.eye();
    const dir = this.local.viewDir();

    if (def.projectile) {
      // Thrown — the grenade itself appears via the next state snapshot.
      this.viewModel.shoot();
      this.sfx.throwNade();
      this.net.send({
        type: "shoot",
        o: [origin.x, origin.y, origin.z],
        d: [dir.x, dir.y, dir.z],
        e: this.local.epoch,
        w: this.weapon,
      });
      const left = (this.ammo[this.weapon] ?? 1) - 1;
      this.ammo[this.weapon] = left;
      this.hud.setWeapon(this.weapon, left);
      if (left <= 0) this.setWeapon(DEFAULT_WEAPON);
      return;
    }

    const muzzle = this.viewModel.muzzleWorld(new THREE.Vector3());
    const avatars = this.remotes.positions();

    // Predicted tracers (the server rolls its own authoritative pellet spread).
    for (let i = 0; i < def.pellets; i++) {
      const d = def.pellets > 1 ? perturbDir(dir, def.spread) : dir;
      let endT = rayAABBs(origin, d, SOLIDS, def.range) ?? def.range;
      if (d.y < -1e-6) {
        const tFloor = -origin.y / d.y;
        if (tFloor > 0 && tFloor < endT) endT = tFloor;
      }
      for (const p of avatars) {
        const t = rayAABB(origin, d, playerAABB(vec3(p.x, p.y, p.z)), def.range);
        if (t !== null && t < endT) endT = t;
      }
      const end = new THREE.Vector3(
        origin.x + d.x * endT,
        origin.y + d.y * endT,
        origin.z + d.z * endT,
      );
      this.effects.tracer(muzzle, end, def.color);
      this.effects.impact(end, def.color);
    }

    this.viewModel.shoot();
    this.sfx.shoot();

    this.net.send({
      type: "shoot",
      o: [origin.x, origin.y, origin.z],
      d: [dir.x, dir.y, dir.z],
      e: this.local.epoch,
      w: this.weapon,
    });

    if (def.ammo !== null) {
      const left = (this.ammo[this.weapon] ?? 1) - 1;
      this.ammo[this.weapon] = left;
      this.hud.setWeapon(this.weapon, left);
      if (left <= 0) this.setWeapon(DEFAULT_WEAPON);
    }
  }

  // --- Loops --------------------------------------------------------------------------

  private startInputLoop(): void {
    if (this.inputTimer !== null) return;
    this.inputTimer = window.setInterval(() => {
      if (!this.playing || this.local.dead) return;
      this.net.send({
        type: "input",
        p: [
          Math.round(this.local.pos.x * 1000) / 1000,
          Math.round(this.local.pos.y * 1000) / 1000,
          Math.round(this.local.pos.z * 1000) / 1000,
        ],
        yaw: Math.round(this.local.yaw * 1000) / 1000,
        pitch: Math.round(this.local.pitch * 1000) / 1000,
        e: this.local.epoch,
      });
    }, INPUT_MS);
  }

  private frame(now: number): void {
    requestAnimationFrame((t) => this.frame(t));
    const dt = Math.min((now - this.lastFrame) / 1000, 0.05);
    this.lastFrame = now;

    for (const code of this.input.consumePressed()) {
      if (code === "KeyM") {
        const muted = this.music.toggle();
        this.hud.flashToast(muted ? "MUSIC OFF" : "MUSIC ON");
      } else if (this.playing && !this.local.dead && code in WEAPON_SLOTS) {
        this.setWeapon(WEAPON_SLOTS[code]);
      } else if (
        this.playing &&
        !this.local.dead &&
        (code === "ControlLeft" || code === "ControlRight")
      ) {
        this.cycleWeapon();
      }
    }

    if (this.playing && this.input.locked && !this.local.dead) {
      this.local.update(dt, this.input);
      if (this.input.firing) this.tryFire(now);
    } else {
      this.input.consumeMouse(); // don't bank deltas while paused/dead
    }

    // Camera follows the local player, with a decaying damage shake.
    this.shake = Math.max(0, this.shake - dt * 5);
    const shakeAmp = this.shake * this.shake * 0.02;
    const eye = this.local.eye();
    this.camera.position.set(eye.x, eye.y, eye.z);
    this.camera.rotation.y = this.local.yaw;
    this.camera.rotation.x = this.local.pitch;
    this.camera.rotation.z = (Math.random() - 0.5) * shakeAmp;

    this.remotes.update(now);
    this.effects.update(now);
    this.viewModel.update(dt);
    this.pickups.update(now);
    this.nadeView.update(dt, now);

    // Critical-health heartbeat.
    if (this.playing && !this.local.dead && this.hp > 0 && this.hp <= 30 && now - this.lastHeartbeat > 1100) {
      this.lastHeartbeat = now;
      this.sfx.heartbeat();
    }

    if (this.local.dead && this.playing) {
      const remaining = Math.max(0, this.deathUntil - now) / 1000;
      this.hud.setDeathCountdown(remaining);
    }
    this.hud.showScoreboard(this.input.scoreboardHeld && this.playing);

    this.renderer.render(this.scene, this.camera);
  }
}
