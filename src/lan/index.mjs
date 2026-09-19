// index.mjs — the LAN multiplayer module's public API.
//
//   startLanRoom({ game, port, discoveryPort })  → host a room AND announce it
//   findRooms({ timeoutMs })                     → discover rooms on the LAN
//   createRoom / createAnnouncer / discoverRooms → the primitives, if you want
//                                                  to wire them yourself
//
// Typical host:
//   const room = await startLanRoom({ game: 'doudizhu' });
//   console.log(room.lanWsUrl);          // ws://192.168.x.x:8766/ws
//   players run: findRooms()             // or join by typing room.lanUrl
//
// Typical client: connect a WebSocket to the advertised `ws` URL and speak the
// protocol in src/engine/protocol.js — or simply use the Client class.

import { createRoom, lanIp, ROOT, BUILTIN } from './room.mjs';
import { createAnnouncer, discoverRooms, broadcastTargets, localAddresses, DEFAULT_DISCOVERY_PORT } from './discovery.mjs';

export { createRoom, lanIp, ROOT, BUILTIN };
export { createAnnouncer, discoverRooms, broadcastTargets, localAddresses, DEFAULT_DISCOVERY_PORT };

/**
 * Host a room and make it discoverable on the LAN.
 * @param {object} [opts]  Same options as createRoom, plus:
 * @param {number} [opts.discoveryPort]  UDP port for discovery (default 8767).
 * @param {boolean} [opts.announce]      Set false to skip the UDP announcer.
 * @param {string} [opts.name]           Friendly room name shown in discovery.
 */
export async function startLanRoom({ discoveryPort = DEFAULT_DISCOVERY_PORT, announce = true, name, ...roomOpts } = {}) {
  const room = await createRoom(roomOpts);

  let announcer = null;
  if (announce) {
    const roomName = name || `${room.host.gameKey} room @ ${room.host.playerName || lanIp()}`;
    try {
      announcer = await createAnnouncer({
        port: discoveryPort,
        info: () => {
          const p = room.host.game.players;
          return {
            name: roomName,
            game: room.host.gameKey,
            http: room.lanUrl + '/',
            ws: room.lanWsUrl,
            players: p.length,
            max: (room.host.gameInfo && room.host.gameInfo.max) || null,
            phase: room.host.game.phase,
          };
        },
        onProbe: (rinfo) => room.logLine && room.logLine(`discovery probe from ${rinfo.address}:${rinfo.port}`),
      });
    } catch (e) {
      // A busy UDP port must not stop the game: the room still works by URL.
      console.warn(`[lan] discovery announcer unavailable (${e && e.message ? e.message : e}) — join by address instead`);
    }
  }

  return {
    ...room,
    name: name || null,
    discoveryPort: announcer ? announcer.port : null,
    /** Stop announcing and close the room. */
    close: async () => {
      if (announcer) { try { await announcer.close(); } catch (_) {} }
      await room.close();
    },
  };
}

/** Find rooms on the LAN (thin, documented wrapper over discoverRooms). */
export function findRooms(opts = {}) {
  return discoverRooms(opts);
}
