// WebSocket client: join handshake, message dispatch, latency pings, and
// automatic reconnection with backoff. The reconnect token (from `welcome`)
// lets the server restore kills/deaths if the socket drops briefly.

import { PING_INTERVAL_MS, PROTOCOL_VERSION } from "../shared/constants";
import { CLOSE_IDLE, CLOSE_OUTDATED, CLOSE_REPLACED } from "../shared/protocol";
import type { ClientMsg, ServerMsg } from "../shared/protocol";

export type NetStatus =
  | "connecting"
  | "open"
  | "reconnecting"
  | "full"
  | "replaced"
  | "outdated"
  | "closed";

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 8000;

export class Net {
  private ws: WebSocket | null = null;
  private readonly url: string;
  private name: string;
  token: string | null = null;
  ping = 0;

  private stopped = false;
  private attempts = 0;
  private pingTimer: number | null = null;
  private reconnectTimer: number | null = null;

  onMessage: (msg: ServerMsg) => void = () => {};
  onStatus: (status: NetStatus) => void = () => {};

  constructor(name: string, token: string | null) {
    this.name = name;
    this.token = token;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    this.url = `${proto}://${location.host}/ws`;
  }

  connect(): void {
    if (this.stopped) return;
    this.onStatus(this.attempts === 0 ? "connecting" : "reconnecting");

    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.onopen = () => {
      const join: ClientMsg = {
        type: "join",
        v: PROTOCOL_VERSION,
        name: this.name,
        token: this.token ?? undefined,
      };
      ws.send(JSON.stringify(join));
    };

    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string") return;
      let msg: ServerMsg;
      try {
        msg = JSON.parse(ev.data) as ServerMsg;
      } catch {
        return;
      }
      if (msg.type === "welcome") {
        this.attempts = 0;
        this.token = msg.token;
        this.startPing();
        this.onStatus("open");
      } else if (msg.type === "full") {
        // Friendly rejection — do not retry into a full room.
        this.stopped = true;
        this.onStatus("full");
      }
      this.onMessage(msg);
    };

    ws.onclose = (ev) => {
      this.stopPing();
      if (this.ws !== ws) return; // superseded by a newer socket
      this.ws = null;
      if (this.stopped) {
        this.onStatus("closed");
        return;
      }

      // Another connection (e.g. a second tab) took over this player's token.
      // Reconnecting would just kick it back — an infinite tug-of-war — so stop.
      if (ev.code === CLOSE_REPLACED) {
        this.stopped = true;
        this.onStatus("replaced");
        return;
      }

      // Protocol mismatch: this bundle can never join — retrying is pointless.
      if (ev.code === CLOSE_OUTDATED) {
        this.stopped = true;
        this.onStatus("outdated");
        return;
      }

      // Idle kick usually means a backgrounded tab whose timers were throttled.
      // Reconnecting while still hidden would re-enter the same kick loop, so
      // wait until the tab is visible again.
      if (ev.code === CLOSE_IDLE && document.visibilityState === "hidden") {
        this.onStatus("reconnecting");
        const onVisible = () => {
          if (document.visibilityState === "visible") {
            document.removeEventListener("visibilitychange", onVisible);
            if (!this.stopped) this.connect();
          }
        };
        document.addEventListener("visibilitychange", onVisible);
        return;
      }

      this.scheduleReconnect();
    };

    ws.onerror = () => {
      // onclose always follows; nothing to do here.
    };
  }

  private scheduleReconnect(): void {
    this.onStatus("reconnecting");
    const delay =
      Math.min(RECONNECT_BASE_MS * 2 ** this.attempts, RECONNECT_MAX_MS) +
      Math.random() * 400;
    this.attempts += 1;
    this.reconnectTimer = window.setTimeout(() => this.connect(), delay);
  }

  send(msg: ClientMsg): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = window.setInterval(() => {
      this.send({ type: "ping", t: performance.now() });
    }, PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  /** Called by the game when a pong arrives. */
  notePong(sentAt: number): void {
    this.ping = Math.round(performance.now() - sentAt);
  }

  close(): void {
    this.stopped = true;
    this.stopPing();
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }
}
