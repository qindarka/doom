// Game orchestration: owns the renderer, wires net messages to simulation and
// presentation, and runs the frame/input loops.

import * as THREE from "three";

import {
  INPUT_MS,
  MAX_HEALTH,
  RESPAWN_DELAY_MS,
  WEAPON_COOLDOWN_MS,
  WEAPON_RANGE,
} from "../shared/constants";
import { SOLIDS } from "../shared/map";
import { playerAABB, rayAABB, rayAABBs, vec3 } from "../shared/math";
import type { PlayerScore, ServerMsg } from "../shared/protocol";
import { Sfx } from "./audio";
import { Effects, ViewModel } from "./effects";
import { Hud } from "./hud";
import { Input } from "./input";
import { Net } from "./net";
import { LocalPlayer } from "./player";
import { Remotes } from "./remotes";
import { buildScene } from "./scene";

const TOKEN_KEY = "ferrofrag.token";

export class Game {
  onJoined: () => void = () => {};
  onFull: () => void = () => {};

  private renderer: THREE.WebGLRenderer;
  private camera: THREE.PerspectiveCamera;
  private scene: THREE.Scene;
  private hud: Hud;
  private input = new Input();
  private sfx = new Sfx();
  private net: Net;
  private local = new LocalPlayer();
  private remotes: Remotes;
  private effects: Effects;
  private viewModel: ViewModel;

  private myId = "";
  private roster = new Map<string, PlayerScore>();
  private hp = MAX_HEALTH;
  private playing = false;
  private deathUntil = 0;
  private lastShotAt = -Infinity;
  private lastFrame = performance.now();
  private inputTimer: number | null = null;
  private shake = 0;

  constructor(root: HTMLElement, name: string) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    root.appendChild(this.renderer.domElement);

    this.scene = buildScene();
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

    this.net = new Net(name, localStorage.getItem(TOKEN_KEY));
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
        const end = new THREE.Vector3(
          msg.o[0] + msg.d[0] * msg.t,
          msg.o[1] + msg.d[1] * msg.t,
          msg.o[2] + msg.d[2] * msg.t,
        );
        const start = this.remotes.muzzleOf(msg.id) ?? origin;
        this.effects.tracer(start, end, 0xffb060);
        if (!msg.hitId) this.effects.impact(end, 0xffaa44);

        // Positional-ish audio: pan by the shooter's side, fade by distance.
        const toShooter = origin.clone().sub(this.camera.position);
        const distance = toShooter.length();
        const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
        const pan = Math.max(-0.9, Math.min(0.9, right.dot(toShooter.normalize())));
        const vol = Math.max(0.1, Math.min(1, 1 - distance / 45));
        this.sfx.shootRemote(pan, vol);
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
        if (msg.id === this.myId) {
          this.local.dead = true;
          this.deathUntil = now + RESPAWN_DELAY_MS;
          this.hp = 0;
          this.hud.setHealth(0);
          this.hud.showDeath(killer?.name ?? "???");
          this.sfx.death();
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
    this.remotes.sync(roster, this.myId);
    this.hud.updateScoreboard(roster, this.myId);
    this.hud.setPlayers(roster.length);
  }

  // --- Shooting ----------------------------------------------------------------------

  private tryFire(now: number): void {
    if (now - this.lastShotAt < WEAPON_COOLDOWN_MS) return;
    this.lastShotAt = now;

    const origin = this.local.eye();
    const dir = this.local.viewDir();

    // Predict the impact point for the tracer: nearest of world, floor, players.
    let endT = rayAABBs(origin, dir, SOLIDS, WEAPON_RANGE) ?? WEAPON_RANGE;
    if (dir.y < -1e-6) {
      const tFloor = -origin.y / dir.y;
      if (tFloor > 0 && tFloor < endT) endT = tFloor;
    }
    for (const p of this.remotes.positions()) {
      const t = rayAABB(origin, dir, playerAABB(vec3(p.x, p.y, p.z)), WEAPON_RANGE);
      if (t !== null && t < endT) endT = t;
    }

    const muzzle = this.viewModel.muzzleWorld(new THREE.Vector3());
    const end = new THREE.Vector3(
      origin.x + dir.x * endT,
      origin.y + dir.y * endT,
      origin.z + dir.z * endT,
    );
    this.effects.tracer(muzzle, end, 0xffc070);
    this.effects.impact(end, 0xffaa44);
    this.viewModel.shoot();
    this.sfx.shoot();

    this.net.send({
      type: "shoot",
      o: [origin.x, origin.y, origin.z],
      d: [dir.x, dir.y, dir.z],
      e: this.local.epoch,
    });
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

    if (this.local.dead && this.playing) {
      const remaining = Math.max(0, this.deathUntil - now) / 1000;
      this.hud.setDeathCountdown(remaining);
    }
    this.hud.showScoreboard(this.input.scoreboardHeld && this.playing);

    this.renderer.render(this.scene, this.camera);
  }
}
