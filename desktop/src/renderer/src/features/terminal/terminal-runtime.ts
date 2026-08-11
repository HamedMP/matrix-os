// Singleton attach manager wiring sockets to the connection profile.
// Single live attachment app-wide (lesson L4); buffers cached LRU for instant
// task switching (FR-022, SC-006).
import { AttachManager } from "./attach-manager";
import { ShellSocket, type ShellSocketEvents } from "../../lib/shell-socket";
import { useConnection } from "../../stores/connection";

let manager: AttachManager | null = null;

export function getAttachManager(): AttachManager {
  if (!manager) {
    manager = new AttachManager({
      createSocket: (sessionName: string, events: ShellSocketEvents) => {
        const { platformHost, runtimeSlot } = useConnection.getState();
        return new ShellSocket({
          baseUrl: platformHost,
          sessionName,
          runtimeSlot,
          events,
        });
      },
    });
  }
  return manager;
}

export function resetAttachManager(): void {
  manager?.dispose();
  manager = null;
}
