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

function createSocket(sessionName: string, events: ShellSocketEvents, chatId?: string): SocketControl {
  if (alternateSockets && sessionName.startsWith(alternateSockets.prefix)) return alternateSockets.create(sessionName, events);
  const { platformHost, runtimeSlot } = useConnection.getState();
  return new ShellSocket({
    baseUrl: platformHost,
    sessionName,
    chatId,
    runtimeSlot,
    events,
  });
}

export function getAttachManager(): AttachManager {
  manager ??= new AttachManager({ createSocket });
  return manager;
}

/**
 * A manager of its own for one pane of the Terminal window (spec 2706), so
 * every visible pane streams live. The window bounds how many exist (one per
 * pane, at most 16 per tab) and disposes each with its pane.
 */
export function createPaneAttachManager(): AttachManager {
  return new AttachManager({ createSocket, bufferCacheCap: 1 });
}

export function resetAttachManager(): void {
  manager?.dispose();
  manager = null;
}
