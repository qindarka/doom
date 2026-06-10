// Generative, key-free ambient music — no samples, no tonal centre. Layers:
//   drone   two detuned saws random-walking in the 50–90Hz band, low-passed
//   swells  band-passed noise washes every ~10s
//   plinks  inharmonic FM "metal" hits through a feedback echo
//   pulse   (game mode only) a slow industrial heartbeat
// The menu mode is sparse and dark; game mode adds the pulse and more plinks.

type Mode = "menu" | "game";

export class Music {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private droneGain: GainNode | null = null;
  private pulseGain: GainNode | null = null;
  private echo: DelayNode | null = null;
  private echoInput: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  private droneOscs: OscillatorNode[] = [];
  private droneFreq = 64;
  private nextPlinkAt = 0;
  private nextSwellAt = 0;
  private nextPulseAt = 0;
  private mode: Mode = "menu";
  private muted: boolean;

  constructor() {
    this.muted = localStorage.getItem("ferrofrag.music") === "off";
  }

  get isMuted(): boolean {
    return this.muted;
  }

  /** Call from a user-gesture handler; safe to call repeatedly. */
  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === "suspended") void this.ctx.resume();
      return;
    }
    const Ctx =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    this.ctx = ctx;

    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.14;
    this.master.connect(ctx.destination);

    // feedback echo bus for the plinks
    this.echo = ctx.createDelay(1.5);
    this.echo.delayTime.value = 0.43;
    const feedback = ctx.createGain();
    feedback.gain.value = 0.42;
    const echoFilter = ctx.createBiquadFilter();
    echoFilter.type = "lowpass";
    echoFilter.frequency.value = 2400;
    this.echoInput = ctx.createGain();
    this.echoInput.connect(this.echo);
    this.echo.connect(echoFilter).connect(feedback).connect(this.echo);
    this.echo.connect(this.master);
    this.echoInput.connect(this.master);

    // drone bed
    this.droneGain = ctx.createGain();
    this.droneGain.gain.value = 0.05;
    const droneFilter = ctx.createBiquadFilter();
    droneFilter.type = "lowpass";
    droneFilter.frequency.value = 320;
    this.droneGain.connect(droneFilter).connect(this.master);
    for (const detune of [-7, 6]) {
      const osc = ctx.createOscillator();
      osc.type = "sawtooth";
      osc.frequency.value = this.droneFreq;
      osc.detune.value = detune;
      osc.connect(this.droneGain);
      osc.start();
      this.droneOscs.push(osc);
    }

    // game-mode pulse bus
    this.pulseGain = ctx.createGain();
    this.pulseGain.gain.value = this.mode === "game" ? 1 : 0;
    this.pulseGain.connect(this.master);

    // noise buffer for swells
    const len = Math.floor(ctx.sampleRate * 2);
    this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

    const t = ctx.currentTime;
    this.nextPlinkAt = t + 1.5;
    this.nextSwellAt = t + 4;
    this.nextPulseAt = t + 0.5;
    window.setInterval(() => this.schedule(), 400); // lives for the page lifetime
  }

  setMode(mode: Mode): void {
    this.mode = mode;
    if (this.ctx && this.pulseGain) {
      this.pulseGain.gain.linearRampToValueAtTime(
        mode === "game" ? 1 : 0,
        this.ctx.currentTime + 2.5,
      );
    }
  }

  /** Returns the new muted state. */
  toggle(): boolean {
    this.muted = !this.muted;
    localStorage.setItem("ferrofrag.music", this.muted ? "off" : "on");
    if (this.ctx && this.master) {
      this.master.gain.linearRampToValueAtTime(this.muted ? 0 : 0.14, this.ctx.currentTime + 0.4);
    }
    if (!this.muted) this.unlock();
    return this.muted;
  }

  // --- Generative scheduler (runs ~0.8s ahead of the clock) --------------------

  private schedule(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    // Never let the cursors fall behind the audio clock (muted spans, throttled
    // background tabs) — draining a backlog would create thousands of nodes in
    // one tick and play them all at once.
    const floor = ctx.currentTime - 0.1;
    this.nextPlinkAt = Math.max(this.nextPlinkAt, floor);
    this.nextSwellAt = Math.max(this.nextSwellAt, floor);
    this.nextPulseAt = Math.max(this.nextPulseAt, floor);
    if (this.muted) return;
    const horizon = ctx.currentTime + 0.8;

    // drone random walk — continuous pitch, never settles on a key
    this.droneFreq = Math.min(92, Math.max(48, this.droneFreq + (Math.random() - 0.5) * 4));
    for (const osc of this.droneOscs) {
      osc.frequency.linearRampToValueAtTime(this.droneFreq, ctx.currentTime + 2.5);
    }

    while (this.nextPlinkAt < horizon) {
      this.plink(this.nextPlinkAt);
      const gap = this.mode === "game" ? 2.2 : 4.0;
      this.nextPlinkAt += gap * (0.4 + Math.random() * 1.6);
    }
    while (this.nextSwellAt < horizon) {
      this.swell(this.nextSwellAt);
      this.nextSwellAt += 7 + Math.random() * 8;
    }
    while (this.nextPulseAt < horizon) {
      if (this.mode === "game") this.pulse(this.nextPulseAt);
      this.nextPulseAt += 1.05;
    }
  }

  /** Inharmonic FM strike — sounds like struck rebar, pitch drawn uniformly. */
  private plink(at: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.echoInput) return;
    const carrierHz = 320 + Math.random() * 1900;
    const ratio = 2.41 + Math.random() * 1.3; // non-integer => clangorous
    const decay = 1.2 + Math.random() * 1.6;

    const carrier = ctx.createOscillator();
    carrier.type = "sine";
    carrier.frequency.value = carrierHz;
    const mod = ctx.createOscillator();
    mod.type = "sine";
    mod.frequency.value = carrierHz * ratio;
    const modGain = ctx.createGain();
    modGain.gain.setValueAtTime(carrierHz * 1.4, at);
    modGain.gain.exponentialRampToValueAtTime(1, at + decay);
    mod.connect(modGain).connect(carrier.frequency);

    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0.05 + Math.random() * 0.05, at);
    amp.gain.exponentialRampToValueAtTime(0.0004, at + decay);
    const pan = ctx.createStereoPanner();
    pan.pan.value = Math.random() * 1.6 - 0.8;

    carrier.connect(amp).connect(pan).connect(this.echoInput);
    carrier.start(at);
    carrier.stop(at + decay + 0.1);
    mod.start(at);
    mod.stop(at + decay + 0.1);
  }

  /** Slow band-passed noise wash. */
  private swell(at: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.noiseBuf || !this.master) return;
    const dur = 4 + Math.random() * 4;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = 180 + Math.random() * 700;
    filter.Q.value = 2.5;
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0.0001, at);
    amp.gain.exponentialRampToValueAtTime(0.035, at + dur * 0.5);
    amp.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    src.connect(filter).connect(amp).connect(this.master);
    src.start(at);
    src.stop(at + dur + 0.1);
  }

  /** Industrial heartbeat: a dull sub thump, game mode only. */
  private pulse(at: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.pulseGain) return;
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(74, at);
    osc.frequency.exponentialRampToValueAtTime(38, at + 0.22);
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0.16, at);
    amp.gain.exponentialRampToValueAtTime(0.001, at + 0.3);
    osc.connect(amp).connect(this.pulseGain);
    osc.start(at);
    osc.stop(at + 0.4);
  }
}
