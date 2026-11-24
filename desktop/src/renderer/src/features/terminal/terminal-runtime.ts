// Singleton attach manager wiring sockets to the connection profile.
// Single live attachment app-wide (lesson L4); buffers cached LRU for instant
// task switching (FR-022, SC-006).
import { AttachManager, type SocketControl } from "./attach-manager";
import { ShellSocket, type ShellSocketEvents } from "../../lib/shell-socket";
import { useConnection } from "../../stores/connection";

let manager: AttachManager | null = null;

// The Terminal window registers factories for terminals that are not gateway
// sockets (local ones, and teammates' shared ones). Sessions are matched by
// name prefix; a handful of kinds exist, so the registry is small and capped.
type SocketFactory = (sessionName: string, events: ShellSocketEvents) => SocketControl;
const MAX_ALTERNATE_SOCKETS = 4;
const alternateSockets = new Map<string, SocketFactory>();
let legacyPrefix: string | null = null;

export function setAlternateTerminalSockets(factory: { prefix: string; create: SocketFactory } | null): void {
  if (legacyPrefix) alternateSockets.delete(legacyPrefix);
  legacyPrefix = factory?.prefix ?? null;
  if (factory) alternateSockets.set(factory.prefix, factory.create);
}

/** Adds sockets for one more session prefix; the returned function removes them. */
export function registerAlternateTerminalSockets(prefix: string, create: SocketFactory): () => void {
  if (!alternateSockets.has(prefix) && alternateSockets.size >= MAX_ALTERNATE_SOCKETS) throw new Error("Terminal socket kinds are full");
  alternateSockets.set(prefix, create);
  return () => { if (alternateSockets.get(prefix) === create) alternateSockets.delete(prefix); };
}

function createSocket(sessionName: string, events: ShellSocketEvents, chatId?: string): SocketControl {
  for (const [prefix, create] of alternateSockets) {
    if (sessionName.startsWith(prefix)) return create(sessionName, events);
  }
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
