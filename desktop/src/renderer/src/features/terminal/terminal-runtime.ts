// Singleton attach manager wiring sockets to the connection profile.
// Single live attachment app-wide (lesson L4); buffers cached LRU for instant
// task switching (FR-022, SC-006).
import { AttachManager, type SocketControl } from "./attach-manager";
import { ShellSocket, type ShellSocketEvents } from "../../lib/shell-socket";
import { useConnection } from "../../stores/connection";

let manager: AttachManager | null = null;

// The Terminal window registers a factory for terminals that are not gateway
// sockets (local ones). Sessions are matched by name prefix.
let alternateSockets: {
  prefix: string;
  create(sessionName: string, events: ShellSocketEvents): SocketControl;
  /** The source repaints the whole terminal on attach (herdr-core does). */
  repaintsOnAttach?: boolean;
} | null = null;

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
  manager ??= new AttachManager({
    createSocket,
    repaintsOnAttach: (sessionName) => alternateSockets?.repaintsOnAttach === true && sessionName.startsWith(alternateSockets.prefix),
  });
  return manager;
}

// The panes' saved screens, kept past each pane so a finished terminal (which
// cannot be attached again) still shows its output when its tab comes back.
// Least recently used first out.
const PANE_SCREENS_CAP = 16;
const paneScreens = new Map<string, string>();

/**
 * A manager of its own for one pane of the Terminal window (spec 2706), so
 * every visible pane streams live. The window bounds how many exist (one per
 * pane, at most 16 per tab) and disposes each with its pane.
 */
export function createPaneAttachManager(): AttachManager {
  return new AttachManager({ createSocket, sharedBuffers: paneScreens, bufferCacheCap: PANE_SCREENS_CAP });
}


export function resetAttachManager(): void {
  manager?.dispose();
  manager = null;
}
