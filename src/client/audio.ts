// Synthesized sound effects via WebAudio — no audio assets. The context is
// created lazily on the first user gesture (browsers block autoplay).

export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;

  /** Call from a user-gesture handler (click/keydown) to unlock audio. */
  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === "suspended") void this.ctx.resume();
      return;
    }
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    this.ctx = new Ctx();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.35;
    this.master.connect(this.ctx.destination);

    const len = Math.floor(this.ctx.sampleRate * 0.25);
    this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  }

  private env(at: number, peak: number, decay: number): GainNode | null {
    if (!this.ctx || !this.master) return null;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(peak, at);
    g.gain.exponentialRampToValueAtTime(0.001, at + decay);
    g.connect(this.master);
    return g;
  }

  private burst(at: number, filterHz: number, peak: number, decay: number, pan = 0): void {
    if (!this.ctx || !this.noiseBuf) return;
    const g = this.env(at, peak, decay);
    if (!g) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const filter = this.ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = filterHz;
    filter.Q.value = 0.9;
    const panner = this.ctx.createStereoPanner();
    panner.pan.value = pan;
    src.connect(filter).connect(panner).connect(g);
    src.start(at);
    src.stop(at + decay + 0.05);
  }

  private tone(
    at: number,
    type: OscillatorType,
    from: number,
    to: number,
    peak: number,
    decay: number,
    pan = 0,
  ): void {
    if (!this.ctx) return;
    const g = this.env(at, peak, decay);
    if (!g) return;
    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(from, at);
    osc.frequency.exponentialRampToValueAtTime(Math.max(to, 1), at + decay);
    const panner = this.ctx.createStereoPanner();
    panner.pan.value = pan;
    osc.connect(panner).connect(g);
    osc.start(at);
    osc.stop(at + decay + 0.05);
  }

  shoot(): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.burst(t, 2400, 0.5, 0.09);
    this.tone(t, "square", 190, 70, 0.35, 0.1);
  }

  /** A remote player's shot; pan -1..1, vol scaled by distance. */
  shootRemote(pan: number, vol: number): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.burst(t, 1800, 0.3 * vol, 0.1, pan);
    this.tone(t, "square", 160, 60, 0.2 * vol, 0.1, pan);
  }

  hitConfirm(): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.tone(t, "sine", 1320, 1100, 0.22, 0.05);
  }

  hurt(): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.tone(t, "sine", 130, 65, 0.5, 0.18);
    this.burst(t, 500, 0.25, 0.12);
  }

  death(): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.tone(t, "sawtooth", 280, 45, 0.4, 0.55);
    this.burst(t, 900, 0.3, 0.4);
  }

  killConfirm(): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.tone(t, "sine", 660, 660, 0.22, 0.07);
    this.tone(t + 0.09, "sine", 990, 990, 0.22, 0.12);
  }

  respawn(): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.tone(t, "sine", 220, 620, 0.25, 0.2);
  }

  explosion(pan: number, vol: number): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.burst(t, 320, 0.9 * vol, 0.5, pan);
    this.burst(t, 1100, 0.4 * vol, 0.25, pan);
    this.tone(t, "sine", 110, 28, 0.8 * vol, 0.5, pan);
  }

  heal(): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.tone(t, "sine", 320, 520, 0.2, 0.14);
    this.tone(t + 0.1, "sine", 520, 780, 0.2, 0.2);
  }

  /** One lub-dub, played by the game loop while at critical health. */
  heartbeat(): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.tone(t, "sine", 68, 50, 0.5, 0.12);
    this.tone(t + 0.16, "sine", 60, 45, 0.35, 0.1);
  }

  pickup(): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.tone(t, "square", 440, 440, 0.18, 0.06);
    this.tone(t + 0.07, "square", 880, 880, 0.18, 0.1);
    this.burst(t, 3200, 0.15, 0.08);
  }

  shieldHit(): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.tone(t, "triangle", 880, 620, 0.25, 0.08);
  }

  shieldDown(): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.tone(t, "sawtooth", 700, 120, 0.3, 0.3);
    this.burst(t, 1500, 0.2, 0.2);
  }

  teleport(): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.tone(t, "sine", 200, 1400, 0.25, 0.18);
    this.tone(t + 0.12, "sine", 1400, 300, 0.2, 0.22);
    this.burst(t, 2600, 0.18, 0.25);
  }

  jumpPad(): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.tone(t, "square", 140, 420, 0.3, 0.16);
    this.burst(t, 700, 0.2, 0.1);
  }

  /** Escalating fanfare for streak announcements (level 1..4). */
  sting(level: number): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const base = 320 + level * 60;
    for (let i = 0; i <= Math.min(level + 1, 4); i++) {
      this.tone(t + i * 0.08, "square", base * (1 + i * 0.25), base * (1 + i * 0.25), 0.18, 0.12);
    }
    this.burst(t, 2000, 0.12, 0.15);
  }

  /** Wave-incoming war horn. */
  horn(): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.tone(t, "sawtooth", 92, 78, 0.4, 0.9);
    this.tone(t, "sawtooth", 138, 118, 0.3, 0.9);
    this.burst(t + 0.1, 400, 0.2, 0.7);
  }

  slamWarn(): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.tone(t, "square", 220, 440, 0.25, 0.3);
    this.tone(t + 0.35, "square", 220, 440, 0.25, 0.3);
  }

  monsterDie(): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.burst(t, 600, 0.4, 0.2);
    this.tone(t, "sawtooth", 160, 40, 0.3, 0.25);
  }

  door(): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.burst(t, 240, 0.4, 0.5);
    this.tone(t, "sawtooth", 70, 45, 0.25, 0.55);
  }

  throwNade(): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.burst(t, 900, 0.3, 0.12);
    this.tone(t, "sine", 300, 480, 0.12, 0.1);
  }

  weaponSwitch(): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.burst(t, 1400, 0.2, 0.05);
    this.tone(t + 0.03, "square", 240, 240, 0.12, 0.05);
  }
}
