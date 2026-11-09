// loopback.js — in-memory transport pair for tests and local dev.
// Sending on either side delivers the bytes to the other side on the next
// microtask (setTimeout 0), so async delivery and stream chunking behave like a
// real socket (a MessagePort also works and is testable in Node).

import { Transport } from './transport.js';

export function createLoopbackPair() {
  const a = new Transport();
  const b = new Transport();

  const deliver = (to, bytes) => {
    setTimeout(() => {
      if (to.onMessage) to.onMessage(bytes);
    }, 0);
  };

  a.send = (bytes) => deliver(b, bytes);
  b.send = (bytes) => deliver(a, bytes);

  a.close = () => { if (b.onDisconnect) b.onDisconnect(); };
  b.close = () => { if (a.onDisconnect) a.onDisconnect(); };

  return [a, b];
}
