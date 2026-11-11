// Singleton attach manager wiring sockets to the connection profile.
// Single live attachment app-wide (lesson L4); buffers cached LRU for instant
// task switching (FR-022, SC-006).
import { AttachManager, type SocketControl } from "./attach-manager";
import { ShellSocket, type ShellSocketEvents } from "../../lib/shell-socket";
import { useConnection } from "../../stores/connection";

let manager: AttachManager | null = null;

// The Terminal window registers a factory for terminals that are not gateway
// sockets (local ones). Sessions are matched by name prefix.
let alternateSockets: { prefix: string; create(sessionName: string, events: ShellSocketEvents): SocketControl } | null = null;

export function setAlternateTerminalSockets(factory: typeof alternateSockets): void {
  alternateSockets = factory;
}

export function getAttachManager(): AttachManager {
  if (!manager) {
    manager = new AttachManager({
      createSocket: (sessionName: string, events: ShellSocketEvents, chatId?: string) => {
        if (alternateSockets && sessionName.startsWith(alternateSockets.prefix)) return alternateSockets.create(sessionName, events);
        const { platformHost, runtimeSlot } = useConnection.getState();
        return new ShellSocket({
          baseUrl: platformHost,
          sessionName,
          chatId,
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
