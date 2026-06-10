// Keyboard, mouse and Pointer Lock handling. The game loop polls this; nothing
// here mutates game state directly.

export class Input {
  private keys = new Set<string>();
  private dx = 0;
  private dy = 0;
  firing = false;
  scoreboardHeld = false;
  locked = false;
  onLockChange: (locked: boolean) => void = () => {};

  private canvas: HTMLCanvasElement | null = null;

  attach(canvas: HTMLCanvasElement): void {
    this.canvas = canvas;

    document.addEventListener("keydown", (e) => {
      if (e.code === "Tab") {
        e.preventDefault();
        this.scoreboardHeld = true;
        return;
      }
      this.keys.add(e.code);
    });

    document.addEventListener("keyup", (e) => {
      if (e.code === "Tab") {
        e.preventDefault();
        this.scoreboardHeld = false;
        return;
      }
      this.keys.delete(e.code);
    });

    document.addEventListener("mousemove", (e) => {
      if (this.locked) {
        this.dx += e.movementX;
        this.dy += e.movementY;
      }
    });

    document.addEventListener("mousedown", (e) => {
      if (this.locked && e.button === 0) this.firing = true;
    });

    document.addEventListener("mouseup", (e) => {
      if (e.button === 0) this.firing = false;
    });

    document.addEventListener("pointerlockchange", () => {
      this.locked = document.pointerLockElement === this.canvas;
      if (!this.locked) {
        this.keys.clear();
        this.firing = false;
        this.scoreboardHeld = false;
      }
      this.onLockChange(this.locked);
    });

    // If the tab loses focus mid-keypress, keys would otherwise stick.
    window.addEventListener("blur", () => {
      this.keys.clear();
      this.firing = false;
    });
  }

  requestLock(): void {
    // Chromium enforces a ~1.25s cooldown after Esc-exit and rejects the
    // returned promise; swallow it (the user just clicks again).
    const result = this.canvas?.requestPointerLock() as Promise<void> | undefined;
    result?.catch?.(() => {});
  }

  isDown(code: string): boolean {
    return this.keys.has(code);
  }

  /** Returns and clears accumulated mouse deltas since the previous call. */
  consumeMouse(): { dx: number; dy: number } {
    const out = { dx: this.dx, dy: this.dy };
    this.dx = 0;
    this.dy = 0;
    return out;
  }
}
