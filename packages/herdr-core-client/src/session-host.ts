// "Herdr sessions" for one Matrix computer (spec 651 J6): the terminals held
// by the herdr-core the user's Herdr app uses there. This host is given a byte
// stream to that computer's `herdr-core connect` and knows nothing about how
// it was reached. That core is the user's, not the app's: the host lists,
// starts a shell, attaches and ends terminals, and does nothing else to it.
import { describeError } from "#describe-error";
import { connectHc, HcVersionMismatchError, type HcConnection, type HcHello, type HcSocket } from "#client";
import { createHcSessions, discoverHerdrMachines, parseRegisteredMachines, type AttachmentSlots, type HcSessionSink } from "#sessions";

/** The only methods ever sent to a core the app does not own (FR-014). */
export const HERDR_SESSION_METHODS = ["terminal.list", "terminal.run", "terminal.attach", "terminal.kill"] as const;
const ALLOWED_METHODS: ReadonlySet<string> = new Set(HERDR_SESSION_METHODS);
const TRUSTED_LOCAL_METHODS: ReadonlySet<string> = new Set([...HERDR_SESSION_METHODS, "machine.list"]);
const REQUIRED_FEATURES = ["framed", "attach", "shell"];
const OLDEST_PATCH = 14;
// A round trip to the computer, not to a local socket.
const CALL_TIMEOUT_MS = 10_000;
const DEFAULT_IDLE_MS = 60_000;
const BACKOFF_START_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

/** FR-015: the 0.1 line from 0.1.14, with everything this feature calls. Generation is checked by the client. */
export function acceptsRemoteCore(hello: HcHello): boolean {
  const version = /^0\.1\.([0-9]{1,4})$/.exec(hello.version);
  return version !== null && Number(version[1]) >= OLDEST_PATCH
    && REQUIRED_FEATURES.every((feature) => hello.features.includes(feature))
    && HERDR_SESSION_METHODS.every((method) => hello.methods.includes(method));
}

/** Every call passes through here, so nothing outside the list can be written. */
export function restrictHcConnection(connection: HcConnection, allowed: ReadonlySet<string>): HcConnection {
  const refuse = () => Promise.reject(new Error("method not allowed for this terminal runtime"));
  return {
    get version() { return connection.version; },
    call: (method, params, timeoutMs) => (allowed.has(method) ? connection.call(method, params, timeoutMs) : refuse()),
    attach: (params, handlers) => (allowed.has("terminal.attach") ? connection.attach(params, handlers) : refuse()),
    onDisconnect: (listener) => connection.onDisconnect(listener),
    close: () => connection.close(),
  };
}

export type HerdrTransportFailure = "not-installed" | "identity-changed" | "not-enabled" | "unavailable";
/**
 * How the transport says why a stream could not be opened or ended early:
 * thrown from `open`, or emitted as the stream's "error". It carries a fixed
 * kind and no detail.
 */
export class HerdrTransportError extends Error {
  constructor(readonly kind: HerdrTransportFailure) { super("herdr session transport failed"); this.name = "HerdrTransportError"; }
}

export type HerdrSessionHostStatus = "ready" | "unsupported" | HerdrTransportFailure;
// Trying again cannot help until something changes on the computer or in the
// app, so these wait for an explicit retry instead of a timer.
const WAITS_FOR_RETRY: ReadonlySet<HerdrSessionHostStatus> = new Set(["not-installed", "unsupported", "not-enabled"]);

/** What to start instead of the computer's own shell at home. */
export interface HerdrLaunch { argv?: string[]; line?: string; cwd?: string; name?: string }

export interface HerdrSessionHostOptions {
  /** A byte stream to `herdr-core connect` on the computer. Rejects with HerdrTransportError when it can say why. */
  open(): Promise<HcSocket>;
  /** Gateway's own core can identify the SSH machines explicitly configured for Chat. */
  allowMachineInventory?: boolean;
  /** Shared with the window's other hosts, so the attachment budget holds across them. */
  slots?: AttachmentSlots;
  idleMs?: number;
  now?: () => number;
  random?: () => number;
  /**
   * How long one core call may take. A desktop link (spec 2716) waits for the
   * owner's approval on the desktop, so it allows longer than a local core.
   */
  callTimeoutMs?: number;
}

export function createHerdrSessionHost(options: HerdrSessionHostOptions, sink: HcSessionSink) {
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
  let connection: HcConnection | null = null;
  let connecting: Promise<HcConnection> | null = null;
  let status: HerdrSessionHostStatus = "unavailable";
  let disposed = false;
  let failures = 0;
  let waitsForRetry = false;
  let blockedUntil = 0;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  // Calls the core has not answered yet: a connection waiting on one is never idle.
  let pending = 0;
  let connectedAt = 0;
  let generation = 0;
  // Ends a stream that is still waiting for its handshake; set only while one is.
  let abandonPending: (() => void) | null = null;

  const shutDown = () => new Error("herdr sessions are shut down");

  async function open(): Promise<HcConnection> {
    const socket = await options.open();
    if (disposed) { socket.destroy(); throw shutDown(); }
    const abandoned = new Promise<never>((_, reject) => {
      abandonPending = () => { socket.destroy(); reject(shutDown()); };
    });
    try {
      const opened = await Promise.race([
        connectHc({ open: () => socket, accepts: acceptsRemoteCore, timeoutMs: options.callTimeoutMs ?? CALL_TIMEOUT_MS }),
        abandoned,
      ]);
      return counted(restrictHcConnection(opened, options.allowMachineInventory ? TRUSTED_LOCAL_METHODS : ALLOWED_METHODS));
    } finally {
      abandonPending = null;
    }
  }

  /** A failure: the next dial waits, longer after each failure in a row. */
  function backOff(): void {
    failures += 1;
    const wait = Math.min(BACKOFF_MAX_MS, BACKOFF_START_MS * 2 ** (failures - 1));
    blockedUntil = now() + wait * (0.5 + random() / 2);
  }

  /** A connection that held for a while ends the run of failures; a handshake alone does not. */
  function connectionEnded(): void {
    if (now() - connectedAt >= BACKOFF_MAX_MS) failures = 0;
  }

  function failed(error: unknown): HerdrSessionHostStatus {
    if (error instanceof HerdrTransportError) return error.kind;
    return error instanceof HcVersionMismatchError ? "unsupported" : "unavailable";
  }

  /** Closes the connection once nothing has used it for a while and no terminal is open. */
  function touch(): void {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    if (!connection || disposed) return;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (sessions.attached() > 0 || pending > 0) { touch(); return; }
      const idle = connection;
      connection = null;
      connectionEnded();
      idle?.close();
    }, idleMs);
    idleTimer.unref?.();
  }

  /** Counts calls in flight, so a slow answer (one waiting for an owner's approval) keeps the connection. */
  function counted(connection: HcConnection): HcConnection {
    return {
      get version() { return connection.version; },
      call: async (method, params, timeoutMs) => {
        pending += 1;
        try {
          return await connection.call(method, params, timeoutMs);
        } finally {
          pending -= 1;
          touch();
        }
      },
      attach: (params, handlers) => connection.attach(params, handlers),
      onDisconnect: (listener) => connection.onDisconnect(listener),
      close: () => connection.close(),
    };
  }

  function ensure(): Promise<HcConnection> {
    if (disposed) return Promise.reject(shutDown());
    if (connection) { touch(); return Promise.resolve(connection); }
    if (connecting) return connecting;
    // The window polls; a computer that cannot be reached is not dialed on every poll.
    if (waitsForRetry || now() < blockedUntil) return Promise.reject(new Error("herdr sessions are not reachable yet"));
    connecting = open()
      .then((opened) => {
        if (disposed) { opened.close(); throw shutDown(); }
        connection = opened;
        generation += 1;
        status = "ready";
        connectedAt = now();
        opened.onDisconnect(() => {
          // Closed by this host (idle or disposed): not a failure.
          if (connection !== opened) return;
          connection = null;
          status = "unavailable";
          connectionEnded();
          backOff();
          sessions.connectionLost();
        });
        touch();
        return opened;
      })
      .catch((error: unknown) => {
        if (disposed) throw error;
        status = failed(error);
        waitsForRetry = WAITS_FOR_RETRY.has(status);
        backOff();
        // The name only: what a transport or a remote core says stays out of the log.
        console.warn("[herdr-sessions] unavailable:", status, describeError(error).split(":")[0]);
        throw error;
      })
      .finally(() => { connecting = null; });
    return connecting;
  }

  const sessions = createHcSessions({ ensure, slots: options.slots, now }, sink);

  return {
    status: (): HerdrSessionHostStatus => status,
    list: sessions.list,
    async discoverTerminals() {
      const core = await ensure();
      const reply = await core.call("terminal.list", {});
      if (disposed || connection !== core) throw shutDown();
      return discoverHerdrMachines(reply);
    },
    /** Inspect through the restricted, current connection. Never rebind a process to another core. */
    async listProcesses() {
      const core = await ensure();
      const terminals = await sessions.listProcesses(core);
      if (disposed || connection !== core) throw shutDown();
      return { terminals, generation };
    },
    async listRemoteProcesses() {
      const core = await ensure();
      const [terminals, routes] = await Promise.all([sessions.listProcesses(core, true), core.call("machine.list", {})]);
      if (disposed || connection !== core) throw shutDown();
      return { terminals, machines: parseRegisteredMachines(routes), generation };
    },
    isCurrentGeneration: (expected: number) => !disposed && connection !== null && generation === expected,

    /**
     * Starts that computer's own shell in its home directory, or (`launch`) a
     * program or shell line in a folder there. Returns null when too many were
     * started just now. Callers validate `launch`; the far end checks it again.
     */
    create(size: { cols: number; rows: number }, launch: HerdrLaunch = {}): Promise<string | null> {
      return sessions.run({
        ...(launch.argv ? { argv: launch.argv } : {}),
        ...(launch.line ? { line: launch.line } : {}),
        ...(launch.cwd ? { cwd: launch.cwd } : {}),
        ...(launch.name ? { name: launch.name } : {}),
        size, env: { TERM: "xterm-256color", COLORTERM: "truecolor" }, no_parent: true, no_notify: true, wait: false,
      }, { deadlineMs: options.callTimeoutMs ?? CALL_TIMEOUT_MS });
    },

    kill: sessions.kill,
    attach: sessions.attach,
    acknowledge: sessions.acknowledge,
    input: sessions.input,
    resize: sessions.resize,
    detach: sessions.detach,
    detachAll: sessions.detachAll,

    /** The user asked again (refresh, or the group was reopened): dial on the next use. */
    retry(): void {
      waitsForRetry = false;
      blockedUntil = 0;
      failures = 0;
    },

    /** Closes the connection. Every terminal on the computer keeps running. */
    dispose(): void {
      disposed = true;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = null;
      sessions.drop();
      abandonPending?.();
      connection?.close();
      connection = null;
    },
  };
}

export type HerdrSessionHost = ReturnType<typeof createHerdrSessionHost>;
