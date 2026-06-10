// Worker entry point.
//
// Static assets (the built client in dist/client) are served by the Workers
// Static Assets layer before this script runs. Only requests that match no
// asset arrive here — the WebSocket endpoint and the status API, both of which
// are forwarded to the single shared GameRoom Durable Object.

import { GameRoom } from "./GameRoom";

export { GameRoom };

export interface Env {
  GAME_ROOM: DurableObjectNamespace;
}

/** Every visitor joins the same room: one arena for the whole deployment. */
const ROOM_NAME = "main-arena";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/ws" || url.pathname === "/api/status") {
      const id = env.GAME_ROOM.idFromName(ROOM_NAME);
      return env.GAME_ROOM.get(id).fetch(request);
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
