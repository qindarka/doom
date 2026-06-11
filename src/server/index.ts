// Worker entry point.
//
// Static assets (the built client in dist/client) are served by the Workers
// Static Assets layer before this script runs. Only requests that match no
// asset arrive here — the WebSocket endpoint and the status API, both of which
// are forwarded to a GameRoom Durable Object.

import { HORDE_ROOM, SOLO_ROOM_PREFIX } from "../shared/constants";
import { GameRoom } from "./GameRoom";

export { GameRoom };

export interface Env {
  GAME_ROOM: DurableObjectNamespace;
}

/** Every visitor joins the same room: one arena for the whole deployment. */
const MAIN_ROOM = "main-arena";

/**
 * /ws optionally takes ?room=solo-<id> for a private practice arena with bots.
 * Anything that is not a well-formed solo room collapses to the main arena.
 */
function roomName(url: URL): string {
  const room = url.searchParams.get("room");
  if (room === HORDE_ROOM) return room;
  if (room && room.startsWith(SOLO_ROOM_PREFIX) && /^[a-z0-9-]{6,48}$/.test(room)) {
    return room;
  }
  return MAIN_ROOM;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/ws") {
      const id = env.GAME_ROOM.idFromName(roomName(url));
      return env.GAME_ROOM.get(id).fetch(request);
    }

    if (url.pathname === "/api/status") {
      const id = env.GAME_ROOM.idFromName(MAIN_ROOM);
      return env.GAME_ROOM.get(id).fetch(request);
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
