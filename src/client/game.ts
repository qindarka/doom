// Game orchestration: owns the renderer, wires net messages to simulation and
// presentation, and runs the frame/input loops.

import * as THREE from "three";

import {
  BOOTS_MULT,
  DEFAULT_WEAPON,
  ENV_KILLERS,
  HORDE_ROOM,
  INPUT_MS,
  MAX_HEALTH,
  MAX_SHIELD,
  MONSTER_NAMES,
  OVERSHIELD,
  RESPAWN_DELAY_MS,
  WEAPONS,
} from "../shared/constants";
import type { WeaponId } from "../shared/constants";
import { ITEM_SPAWNS, SOLIDS } from "../shared/map";
import {
  DOOR_ANIM_MS,
  DOOR_BOX,
  ELEVATOR,
  elevatorBoxAt,
  elevatorTopAt,
  inSecretChamber,
} from "../shared/dynamics";
import { perturbDir, playerAABB, rayAABB, rayAABBs, vec3 } from "../shared/math";
import type { PlayerScore, ServerMsg } from "../shared/protocol";
import { Sfx } from "./audio";
import { Effects, NadeView, ViewModel } from "./effects";
import { Hud } from "./hud";
import { Input } from "./input";
import { MonsterView } from "./monsters";
import type { Music } from "./music";
import { Net } from "./net";
import { Pickups } from "./pickups";
import { LocalPlayer } from "./player";
import { Remotes } from "./remotes";
import { buildScene, type ScreenBoard } from "./scene";

const TOKEN_KEY = "ferrofrag.token";
const HORDE_TOKEN_KEY = "ferrofrag.token.horde";

const WEAPON_SLOTS: Record<string, WeaponId> = {
  Digit1: "riveter",
  Digit2: "scrapshot",
  Digit3: "arcwelder",
  Digit4: "frag",
  Digit5: "lance",
  Digit6: "smelter",
};

/** Ctrl (either side, any OS) cycles through owned weapons in this order. */
const CYCLE_ORDER: WeaponId[] = ["riveter", "scrapshot", "arcwelder", "frag", "lance", "smelter"];

const STREAK_TEXT: Record<string, string> = {
  multi2: "DOUBLE FRAG",
  multi3: "TRIPLE FRAG",
  multi4: "QUAD FRAG",
  multi5: "OVERKILL",
  spree3: "KILLING SPREE",
  spree5: "RAMPAGE",
  spree8: "UNSTOPPABLE",
  spree10: "GODLIKE",
};

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
  private shield = MAX_SHIELD;
  private clockOffset: number | null = null;
  private doorOpen = false;
  private doorChangedAt = 0;
  private doorMesh!: THREE.Mesh;
  private elevMesh!: THREE.Group;
  private matchLive = true;
  private matchNextAt = 0;
  private secretFound = localStorage.getItem("ferrofrag.secret") === "1";
  private readonly isHorde: boolean;
  /** Where this room's reconnect token persists (null: don't persist). */
  private readonly tokenKey: string | null;
  private monsterView!: MonsterView;
  /** Local buff expiries in performance.now() time. */
  private odUntil = 0;
  private bootsUntil = 0;
  private sceneTick: (now: number, dt: number) => void;
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
    this.isHorde = room === HORDE_ROOM;
    // Tokens are per room: a horde session must not clobber the main-arena
    // identity. One-off practice rooms don't persist at all.
    this.tokenKey = this.isHorde ? HORDE_TOKEN_KEY : room ? null : TOKEN_KEY;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    root.appendChild(this.renderer.domElement);

    const built = buildScene();
    this.scene = built.scene;
    this.screen = built.screen;
    this.sceneTick = built.tick;
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
    this.remotes.onDeath = (_id, pos, color) => this.effects.gibs(pos, color);
    this.monsterView = new MonsterView(this.scene);

    // The secret door: slides into the floor when shot.
    this.doorMesh = new THREE.Mesh(
      new THREE.BoxGeometry(
        DOOR_BOX.max.x - DOOR_BOX.min.x - 0.02,
        DOOR_BOX.max.y - DOOR_BOX.min.y,
        DOOR_BOX.max.z - DOOR_BOX.min.z - 0.02,
      ),
      new THREE.MeshStandardMaterial({ color: 0x232930, roughness: 0.5, metalness: 0.6 }),
    );
    const seam = new THREE.Mesh(
      new THREE.BoxGeometry(DOOR_BOX.max.x - DOOR_BOX.min.x - 0.3, 0.05, 0.06),
      new THREE.MeshBasicMaterial({ color: 0x00ffc8 }),
    );
    seam.position.set(0, 0.6, -(DOOR_BOX.max.z - DOOR_BOX.min.z) / 2);
    this.doorMesh.add(seam);
    this.scene.add(this.doorMesh);

    // The elevator platform.
    this.elevMesh = new THREE.Group();
    const plate = new THREE.Mesh(
      new THREE.BoxGeometry(ELEVATOR.half * 2, ELEVATOR.thickness, ELEVATOR.half * 2),
      new THREE.MeshStandardMaterial({ color: 0x2a323c, roughness: 0.5, metalness: 0.7 }),
    );
    this.elevMesh.add(plate);
    const strip = new THREE.Mesh(
      new THREE.BoxGeometry(ELEVATOR.half * 2 - 0.2, 0.06, ELEVATOR.half * 2 - 0.2),
      new THREE.MeshBasicMaterial({ color: 0xff6a22 }),
    );
    strip.position.y = ELEVATOR.thickness / 2 + 0.01;
    this.elevMesh.add(strip);
    this.scene.add(this.elevMesh);
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

    this.net = new Net(name, this.tokenKey ? localStorage.getItem(this.tokenKey) : null, room);
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
        if (this.tokenKey) localStorage.setItem(this.tokenKey, msg.token);
        this.doorOpen = msg.door;
        this.doorChangedAt = now - 10_000; // settle the animation instantly
        this.local.spawn(msg.spawn, msg.yaw, msg.e);
        this.hp = msg.hp;
        this.hud.setHealth(this.hp);
        this.setRoster(msg.roster);
        this.pickups.setAll(msg.items);
        this.setWeapon(DEFAULT_WEAPON, true);
        this.ammo = {};
        this.shield = msg.hp > 0 ? MAX_SHIELD : 0;
        this.hud.setShield(this.shield);
        this.odUntil = 0;
        this.bootsUntil = 0;
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
        // Smoothed server-clock estimate drives the dynamic geometry (elevator).
        // Compensate the one-way downstream latency with half the measured RTT,
        // or elevator riders sit measurably below the server's platform.
        const off = msg.t - now + this.net.ping / 2;
        this.clockOffset = this.clockOffset === null ? off : this.clockOffset * 0.95 + off * 0.05;
        this.remotes.onState(msg.players, this.myId, now);
        this.nadeView.sync(msg.nades ?? []);
        this.monsterView.sync(msg.m ?? [], now);
        const me = msg.players.find((p) => p.id === this.myId);
        if (me) {
          if (me.hp !== this.hp) {
            this.hp = me.hp;
            this.hud.setHealth(this.hp);
          }
          if (me.s !== this.shield) {
            this.shield = me.s;
            this.hud.setShield(this.shield);
          }
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

      case "item": {
        this.pickups.setAvail(msg.id, msg.avail);
        const spawn = ITEM_SPAWNS.find((s) => s.id === msg.id);
        if (msg.avail && spawn?.announce) {
          this.hud.showBanner("THE SMELTER IS ONLINE");
          this.screen.update(this.rosterArr, "THE SMELTER IS ONLINE");
          this.sfx.sting(3);
        }
        break;
      }

      case "door":
        this.doorOpen = msg.open;
        this.doorChangedAt = now;
        this.sfx.door();
        break;

      case "matchend": {
        this.matchLive = false;
        this.matchNextAt = now + msg.nextIn * 1000;
        this.setRoster(msg.roster);
        const winner = msg.roster.find((p) => p.id === msg.winnerId);
        this.hud.showPodium(`${winner?.name ?? "???"} WINS`, msg.roster, this.myId);
        this.screen.update(msg.roster, `${winner?.name ?? "???"} WINS THE MATCH`);
        this.sfx.sting(msg.winnerId === this.myId ? 4 : 2);
        break;
      }

      case "matchstart":
        this.matchLive = true;
        this.hud.hidePodium();
        this.setRoster(msg.roster);
        this.pickups.setAll(msg.items);
        // The server reset every loadout and buff; mirror it or desync.
        this.ammo = {};
        this.odUntil = 0;
        this.bootsUntil = 0;
        this.setWeapon(DEFAULT_WEAPON, true);
        this.hud.updateBuffs([]);
        this.hud.flashToast("FIGHT!");
        this.sfx.respawn();
        break;

      case "ammo":
        this.ammo[msg.w] = msg.n;
        if (this.weapon === msg.w) {
          this.hud.setWeapon(msg.w, WEAPONS[msg.w].ammo === null ? null : msg.n);
          if (msg.n <= 0) this.setWeapon(DEFAULT_WEAPON);
        }
        break;

      case "zone": {
        const holder = this.roster.get(msg.id)?.name ?? "???";
        this.screen.update(this.rosterArr, `${holder} HOLDS THE BASTION`);
        if (msg.id === this.myId) {
          this.hud.showBanner("BASTION SECURED +1");
          this.sfx.sting(1);
        }
        break;
      }

      case "wave":
        if (msg.state === "incoming") {
          this.hud.showBanner(`WAVE ${msg.n} INCOMING`);
          this.screen.update(this.rosterArr, `WAVE ${msg.n} INCOMING`);
          this.sfx.horn();
        } else if (msg.state === "cleared") {
          this.hud.showBanner(`WAVE ${msg.n} CLEARED`);
          this.screen.update(this.rosterArr, `WAVE ${msg.n} CLEARED`);
          this.sfx.sting(3);
        }
        this.hud.setWave(msg.n, msg.left, msg.state);
        break;

      case "mdeath": {
        const at = this.monsterView.positionOf(msg.id) ?? new THREE.Vector3(msg.p[0], msg.p[1], msg.p[2]);
        const colors = { fiend: 0xff5533, drone: 0x33ddff, warden: 0xffd24a } as const;
        this.effects.gibs(at, colors[msg.k]);
        this.sfx.monsterDie();
        const killer = this.roster.get(msg.by);
        this.hud.addKill(killer, {
          id: "",
          name: MONSTER_NAMES[msg.k] ?? msg.k,
          color: colors[msg.k],
          kills: 0,
          deaths: 0,
        });
        if (msg.by === this.myId) this.sfx.killConfirm();
        if (msg.k === "warden") {
          this.hud.showBanner("THE WARDEN HAS FALLEN");
          this.screen.update(this.rosterArr, "THE WARDEN HAS FALLEN");
          this.sfx.sting(4);
        }
        break;
      }

      case "slam": {
        const at = new THREE.Vector3(msg.p[0], msg.p[1], msg.p[2]);
        this.effects.slamWarning(at, Math.max(200, msg.at - (now + (this.clockOffset ?? 0))));
        this.sfx.slamWarn();
        break;
      }

      case "hordeend":
        this.matchLive = false;
        this.matchNextAt = now + msg.nextIn * 1000;
        this.setRoster(msg.roster);
        this.hud.showPodium(`SURVIVED TO WAVE ${msg.wave}`, msg.roster, this.myId);
        this.screen.update(msg.roster, `THE HORDE PREVAILED AT WAVE ${msg.wave}`);
        this.sfx.death();
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
          const hadShield = this.shield > 0;
          this.hp = msg.hp;
          this.shield = msg.s;
          this.hud.setHealth(this.hp);
          this.hud.setShield(this.shield);
          this.hud.flashDamage();
          if (hadShield && msg.s <= 0) {
            this.sfx.shieldDown();
          } else if (msg.s > 0) {
            this.sfx.shieldHit();
          } else {
            this.sfx.hurt();
          }
          this.shake = Math.max(this.shake, msg.s > 0 ? 0.6 : 1);
        }
        if (msg.by === this.myId) {
          this.hud.flashHitmarker();
          this.sfx.hitConfirm();
        }
        break;

      case "buff":
        if (msg.k === "overdrive") {
          this.odUntil = now + msg.ms;
          this.hud.flashToast("OVERDRIVE — DOUBLE DAMAGE");
        } else if (msg.k === "boots") {
          this.bootsUntil = now + msg.ms;
          this.hud.flashToast("AFTERBURNERS — SPEED BOOST");
        } else {
          this.shield = OVERSHIELD;
          this.hud.setShield(this.shield);
          this.hud.flashToast("OVERSHIELD CHARGED");
        }
        this.sfx.pickup();
        break;

      case "streak": {
        const who = this.roster.get(msg.id)?.name ?? "???";
        if (msg.kind === "ended") {
          this.screen.update(this.rosterArr, `${who}'S SPREE ENDED`);
          break;
        }
        const text = STREAK_TEXT[msg.kind] ?? msg.kind.toUpperCase();
        this.screen.update(this.rosterArr, `${who}: ${text}`);
        if (msg.id === this.myId) {
          this.hud.showBanner(text);
          const level = msg.kind.startsWith("multi") ? Number(msg.kind.slice(5)) - 1 : 3;
          this.sfx.sting(Math.min(4, Math.max(1, level)));
        }
        break;
      }

      case "death": {
        const killer = this.roster.get(msg.by);
        const envName = ENV_KILLERS[msg.by];
        const victim = this.roster.get(msg.id);
        const killerName = killer?.name ?? envName ?? "???";
        this.hud.addKill(envName ?? killer, victim);
        this.screen.update(this.rosterArr, `${killerName} ⚔ ${victim?.name ?? "???"}`);
        if (msg.id === this.myId) {
          this.local.dead = true;
          // Horde: you're down until the wave is cleared (no fixed countdown).
          this.deathUntil = this.isHorde ? now : now + RESPAWN_DELAY_MS;
          this.hp = 0;
          this.shield = 0;
          this.hud.setHealth(0);
          this.hud.setShield(0);
          this.hud.showDeath(killerName);
          this.sfx.death();
          // Pickups and buffs are dropped on death.
          this.ammo = {};
          this.odUntil = 0;
          this.bootsUntil = 0;
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
          if (msg.tp) {
            this.sfx.teleport();
            this.effects.teleportFlash(new THREE.Vector3(msg.p[0], msg.p[1], msg.p[2]));
          } else {
            this.shield = MAX_SHIELD;
            this.hud.setShield(this.shield);
            this.hud.hideDeath();
            this.sfx.respawn();
          }
        } else {
          if (msg.tp) {
            const from = this.remotes.positionOf(msg.id);
            if (from) this.effects.teleportFlash(from);
            this.effects.teleportFlash(new THREE.Vector3(msg.p[0], msg.p[1], msg.p[2]));
            this.sfx.teleport();
          }
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
    if (!this.matchLive) return; // intermission
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
      const color = now < this.odUntil ? 0xfff2cc : def.color;
      this.effects.tracer(muzzle, end, color);
      this.effects.impact(end, color);
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

    // Dynamic geometry: door slide animation + elevator, synced to server time.
    const serverNow = now + (this.clockOffset ?? 0);
    const doorFrac = this.doorOpen
      ? Math.min(1, (now - this.doorChangedAt) / DOOR_ANIM_MS)
      : Math.max(0, 1 - (now - this.doorChangedAt) / DOOR_ANIM_MS);
    this.doorMesh.position.set(0, 1.05 - 2.0 * doorFrac, (DOOR_BOX.min.z + DOOR_BOX.max.z) / 2);
    this.doorMesh.visible = doorFrac < 0.97;
    const elevTop = elevatorTopAt(serverNow);
    this.elevMesh.position.set(ELEVATOR.cx, elevTop - ELEVATOR.thickness / 2, ELEVATOR.cz);
    const extras = [elevatorBoxAt(serverNow)];
    if (!(this.doorOpen && doorFrac >= 1)) extras.push(DOOR_BOX);
    this.local.extraSolids = extras;

    // The classic moment: stepping into the chamber for the first time.
    if (
      !this.secretFound &&
      this.playing &&
      !this.local.dead &&
      inSecretChamber(this.local.pos.x, this.local.pos.y, this.local.pos.z)
    ) {
      this.secretFound = true;
      localStorage.setItem("ferrofrag.secret", "1");
      this.hud.showBanner("✦ SECRET FOUND ✦");
      this.sfx.sting(2);
    }

    if (!this.matchLive) {
      this.hud.updatePodiumCountdown(Math.max(0, (this.matchNextAt - now) / 1000));
    }

    this.local.speedMult = now < this.bootsUntil ? BOOTS_MULT : 1;
    if (this.playing && this.input.locked && !this.local.dead) {
      this.local.update(dt, this.input);
      if (this.local.padLaunched) this.sfx.jumpPad();
      if (this.input.firing) this.tryFire(now);
    } else {
      this.input.consumeMouse(); // don't bank deltas while paused/dead
    }

    // Buff chips with live countdowns.
    const buffs: Array<{ label: string; sec: number }> = [];
    if (now < this.odUntil) buffs.push({ label: "OVERDRIVE", sec: (this.odUntil - now) / 1000 });
    if (now < this.bootsUntil) buffs.push({ label: "AFTERBURNERS", sec: (this.bootsUntil - now) / 1000 });
    this.hud.updateBuffs(buffs);

    // Camera follows the local player, with a decaying damage shake.
    this.shake = Math.max(0, this.shake - dt * 5);
    const shakeAmp = this.shake * this.shake * 0.02;
    const eye = this.local.eye();
    this.camera.position.set(eye.x, eye.y, eye.z);
    this.camera.rotation.y = this.local.yaw;
    this.camera.rotation.x = this.local.pitch;
    this.camera.rotation.z = (Math.random() - 0.5) * shakeAmp;

    this.sceneTick(now, dt);
    this.remotes.update(now);
    this.monsterView.update(now);
    if (this.isHorde) this.hud.setBoss(this.monsterView.warden());
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
