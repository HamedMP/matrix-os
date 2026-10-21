import type { Socket } from "node:net";
import type { Duplex } from "node:stream";

type Transport = Pick<Duplex, "destroyed" | "readableEnded" | "writableEnded" | "destroy" | "on" | "off"> & Partial<Pick<Socket, "setKeepAlive">>;
/** Fixture-only idle lifetime exceeds the 15-minute CI job; traffic in either direction refreshes it. */
export function createWorkflowSocketRegistry() {
  const pairs = new Map<Transport, { socket: Transport; lastTouched: number; touch: () => void; release: () => void }>();
  let closed = false;
  const dead = (socket: Transport) => socket.destroyed || socket.readableEnded || socket.writableEnded;
  const sweep = () => {
    const now = Date.now();
    for (const [target, pair] of pairs) {
      if (dead(target) || dead(pair.socket) || now - pair.lastTouched >= 30 * 60_000) pair.release();
    }
  };
  const timer = setInterval(sweep, 5_000); timer.unref();
  return {
    add(socket: Transport, target: Transport) {
      sweep();
      const touch = () => { const pair = pairs.get(target); if (pair) pair.lastTouched = Date.now(); };
      const release = () => {
        if (!pairs.delete(target)) return;
        for (const transport of [socket, target]) {
          transport.off("data", touch); transport.off("close", release);
          // Keep the error listener for already-queued teardown errors.
          transport.destroy();
        }
      };
      for (const transport of [socket, target]) transport.on("error", release);
      if (closed || pairs.size >= 64 || dead(socket) || dead(target)) { socket.destroy(); target.destroy(); return false; }
      pairs.set(target, { socket, lastTouched: Date.now(), touch, release });
      for (const transport of [socket, target]) {
        transport.setKeepAlive?.(true, 10_000);
        transport.on("data", touch); transport.on("close", release);
      }
      return true;
    },
    close() {
      closed = true; clearInterval(timer);
      for (const pair of pairs.values()) pair.release();
    },
  };
}
