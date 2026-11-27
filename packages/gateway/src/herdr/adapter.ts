// Herdr sessions in Matrix (spec 2701 layer 2): the terminals held by the
// owner's own herdr-core, reached through `herdr-core connect`. The core is
// the owner's, not Matrix's: the adapter lists, attaches, types into and ends
// its terminals, and does nothing else to it.
import { randomBytes, randomUUID } from "node:crypto";
import headless from "@xterm/headless";
import type { TerminalRef, TerminalWorkspace } from "@matrix-os/contracts";
import { SafeDisplayStringSchema } from "@matrix-os/contracts";
import {
  HERDR_SESSION_LIST_MAX, HERDR_TERMINAL_WORKSPACE_ID,
  type HerdrAvailability, type HerdrSession, type HerdrSessionList,
} from "@matrix-os/contracts/herdr-terminals";
import { HcCallError, HcProtocolError, type HcSocket } from "@matrix-os/herdr-core-client/client";
import { ZodError } from "zod/v4";
import { createAttachmentSlots, type HcAttachOptions, type HcListedProcess } from "@matrix-os/herdr-core-client/sessions";
import { createHerdrSessionHost, type HerdrLaunch, type HerdrSessionHostStatus } from "@matrix-os/herdr-core-client/session-host";
import type { TerminalAgentStatusEntry } from "@matrix-os/terminal-runtime";
import { bindHerdrChatTerminal, herdrDirectoryIdentity, herdrProcessRevision, type ChatTerminalSelection } from "./chat-terminal.js";
import { acceptRemoteAttachment, remoteTerminalRevision, type HerdrChatRemoteWorktree } from "./chat-remote.js";
import type { ManagedTerminalRootResolver } from "./managed-terminal-worktree.js";
import { createHerdrRefMap, herdrTerminalRef } from "./refs.js";

const { Terminal: HeadlessTerminal } = headless;

const DEFAULT_TTL_MS = 2_000;
const DEFAULT_REFRESH_MS = 30_000;
/** Attachments across every viewer and verb; each WS viewer holds one. */
export const HERDR_MAX_ATTACHMENTS = 32;
// A read attaches watch-only and renders the core's paint on a grid large
// enough that the core's own screen is not wrapped or clipped: at least this,
// and at least the last writer's size, up to the largest size a writer may set.
const CAPTURE_SIZE = { cols: 300, rows: 100 };
const CAPTURE_MAX_SIZE = { cols: 500, rows: 200 };
const CAPTURE_MAX_SCROLLBACK = 10_000;
const CAPTURE_MAX_CHARS = 8 * 1024 * 1024;
const DEFAULT_CAPTURE_QUIET_MS = 120;
const DEFAULT_CAPTURE_MAX_MS = 1_500;
const CAPTURE_CACHE_MS = 400;
const DEFAULT_INPUT_SIZE = { cols: 120, rows: 36 };
const MAX_REMEMBERED_SIZES = 1_024;
const MAX_EARLY_OUTPUT = 64;
// Terminals that left a successful listing: shown as exited for a while, so a
// wait or a status read sees the exit instead of a terminal that vanished.
const ENDED_TTL_MS = 10 * 60_000;
const MAX_ENDED = 256;
const WORKSPACE_CREATED_AT = new Date(0).toISOString();

/**
 * Why an attachment ended: the terminal itself ended (`exited`), or the
 * connection to herdr-core went away and the terminal may still be running
 * (`disconnected`), so a viewer can attach again.
 */
export type HerdrAttachmentEnd = "exited" | "disconnected";

export interface HerdrAttachmentHandlers {
  /** Call `consumed` once the output has really been taken; until then the core slows down. */
  output(data: string, consumed: () => void): void;
  closed(reason: HerdrAttachmentEnd): void;
}

export interface HerdrAttachment {
  input(data: string, binary?: boolean): boolean;
  resize(cols: number, rows: number): boolean;
  detach(): void;
}

export interface HerdrScreen { viewport: string[]; scrollback: string[] }

export class HerdrAdapterError extends Error {
  constructor(readonly code: "not_found" | "unavailable" | "capacity") {
    super(`Herdr session operation failed: ${code}`);
    this.name = "HerdrAdapterError";
  }
}

function coarse(status: HerdrSessionHostStatus): HerdrAvailability {
  if (status === "ready" || status === "unsupported" || status === "not-installed") return status;
  return "unavailable";
}

function displayName(title: string): string {
  const name = title.slice(0, 120);
  return SafeDisplayStringSchema.safeParse(name).success ? name : "Herdr terminal";
}

/**
 * A fixed word for why listing failed. What a core says (its error kind or
 * message) is untrusted and never logged.
 */
function listingFailureKind(error: unknown): string {
  if (error instanceof HcCallError) return "call_error";
  if (error instanceof HcProtocolError) return "protocol_error";
  if (error instanceof ZodError) return "invalid_reply";
  if (error instanceof Error && error.message === "local terminal call timed out") return "timeout";
  if (error instanceof Error && error.message === "herdr sessions are not reachable yet") return "backing_off";
  return "unavailable";
}

/** The last `lines` rows of history; none for 0. */
function trimHistory(rows: string[], lines: number): string[] {
  return lines > 0 ? rows.slice(-lines) : [];
}

export function createHerdrAdapter(options: {
  /** A byte stream to `herdr-core connect`. Rejects with HerdrTransportError when it can say why. */
  open(): Promise<HcSocket>;
  /** Ends whatever the transport started (the spawned children). */
  closeTransport?(): void;
  now?: () => number;
  random?: () => number;
  ttlMs?: number;
  refreshMs?: number;
  captureQuietMs?: number;
  captureMaxMs?: number;
  /** One core call's deadline; see `HerdrSessionHostOptions.callTimeoutMs`. */
  callTimeoutMs?: number;
  remoteWorktrees?: readonly HerdrChatRemoteWorktree[];
}) {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const captureQuietMs = options.captureQuietMs ?? DEFAULT_CAPTURE_QUIET_MS;
  const captureMaxMs = options.captureMaxMs ?? DEFAULT_CAPTURE_MAX_MS;
  const refs = createHerdrRefMap();
  // A remotely selectable tab must not become reachable through the generic local workspace API.
  const remoteChatRefs = createHerdrRefMap();
  const enrolledChatRefs = createHerdrRefMap();
  const remoteWorktrees = options.remoteWorktrees ?? [];
  const processSalt = randomUUID();
  // Bounded by the attachment slots; entries leave on detach and close.
  const viewers = new Map<number, HerdrAttachmentHandlers>();
  // Output can arrive in the same read as the attach answer, before the
  // attachment id is known here. Bounded; ids are never reused.
  const early = new Map<number, Array<{ data: string } | { closed: HerdrAttachmentEnd }>>();
  // Last size a Matrix writer used per terminal, so a verb's short attachment does not fight it. LRU-bounded.
  const sizes = new Map<string, { cols: number; rows: number }>();
  // Status words with the time each was first seen; pruned to listed terminals.
  const reported = new Map<string, { status: string; message?: string; at: number }>();
  // One entry per terminal: the deepest recent read, trimmed for shallower ones.
  const captures = new Map<string, { at: number; lines: number; screen: Promise<HerdrScreen> }>();
  let cache: { at: number; value: HerdrSessionList } | null = null;
  // Live terminals as of the last successful listing (bounded by the listing cap),
  // and terminals that have ended since (bounded by MAX_ENDED and ENDED_TTL_MS).
  // A failed listing changes neither: an unreachable core is not an exit.
  let lastLive = new Map<string, string>();
  const ended = new Map<string, { tabId: string; title: string; at: number }>();
  // The last listing failure logged; logged again only when it changes or after a success.
  let loggedFailure: string | null = null;
  let listing: Promise<HerdrSessionList> | null = null;
  let closed = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  // Set when the current core connection's stream ends or fails. The client
  // closes every attachment as part of that teardown, after the stream's own
  // close/error listeners (registered here first) have run; a terminal that
  // ends while the connection is up arrives with this still false.
  let connectionDown = false;
  let currentSocket: HcSocket | null = null;

  async function open(): Promise<HcSocket> {
    const socket = await options.open();
    currentSocket = socket;
    connectionDown = false;
    // A late event from a connection already replaced says nothing about the new one.
    const down = () => { if (currentSocket === socket) connectionDown = true; };
    socket.on("close", down);
    socket.on("error", down);
    // The client tears down on a protocol error by destroying the stream first.
    const destroy = socket.destroy.bind(socket);
    socket.destroy = () => { down(); destroy(); };
    return socket;
  }

  const host = createHerdrSessionHost({
    allowMachineInventory: remoteWorktrees.length > 0,
    open,
    slots: createAttachmentSlots(HERDR_MAX_ATTACHMENTS),
    now,
    ...(options.random ? { random: options.random } : {}),
    ...(options.callTimeoutMs ? { callTimeoutMs: options.callTimeoutMs } : {}),
  }, {
    output(attachId, data) {
      const viewer = viewers.get(attachId);
      if (viewer) { viewer.output(data, () => { host.acknowledge(attachId, 1); }); return; }
      queueEarly(attachId, { data });
    },
    closed(attachId) {
      const reason: HerdrAttachmentEnd = connectionDown ? "disconnected" : "exited";
      const viewer = viewers.get(attachId);
      if (viewer) { viewers.delete(attachId); viewer.closed(reason); return; }
      queueEarly(attachId, { closed: reason });
    },
  });

  function queueEarly(attachId: number, entry: { data: string } | { closed: HerdrAttachmentEnd }): void {
    const queue = early.get(attachId) ?? [];
    if (!early.has(attachId)) {
      early.set(attachId, queue);
      while (early.size > HERDR_MAX_ATTACHMENTS) {
        const oldest = early.keys().next().value;
        if (oldest === undefined) break;
        early.delete(oldest);
      }
    }
    if (queue.length < MAX_EARLY_OUTPUT) queue.push(entry);
  }

  function unavailable(status: HerdrAvailability): HerdrSessionList {
    return { available: false, status, sessions: [] };
  }

  async function load(chatSelection?: "gateway" | "desktop" | ManagedTerminalRootResolver): Promise<HerdrSessionList> {
    if (closed) return unavailable("unavailable");
    try {
      const { terminals, generation } = await host.listProcesses();
      const live = new Set<string>();
      const listed = terminals.slice(0, HERDR_SESSION_LIST_MAX);
      const sessions: HerdrSession[] = listed.map((process) => {
        const { terminal } = process;
        live.add(terminal.id);
        const ref = refs.remember(terminal.id);
        if (terminal.status) {
          const previous = reported.get(terminal.id);
          if (!previous || previous.status !== terminal.status || previous.message !== terminal.statusMessage) {
            reported.set(terminal.id, { status: terminal.status, ...(terminal.statusMessage ? { message: terminal.statusMessage } : {}), at: now() });
          }
        } else reported.delete(terminal.id);
        return {
          id: terminal.id,
          tabId: ref.tabId,
          title: terminal.title,
          status: terminal.status,
          ...(terminal.statusMessage ? { statusMessage: terminal.statusMessage } : {}),
        };
      });
      for (const id of [...reported.keys()]) if (!live.has(id)) reported.delete(id);
      noteEnded(sessions);
      loggedFailure = null;
      if (chatSelection === "desktop") {
        for (const [i, process] of listed.entries()) {
          if (process.selectionRevision) sessions[i]!.revision = process.selectionRevision;
        }
        if (sessions.length < HERDR_SESSION_LIST_MAX) {
          sessions.push(...await listEnrolledChatSessions(HERDR_SESSION_LIST_MAX - sessions.length));
        }
      } else if (chatSelection === "gateway" || typeof chatSelection === "function") {
        // A grant selects a specific checkout inode. Normal session polling never needs filesystem I/O.
        const directories = new Map<string, ReturnType<typeof herdrDirectoryIdentity>>();
        async function authorizedDirectory(cwd: string) {
          const root = typeof chatSelection === "function" ? await chatSelection(cwd) : cwd;
          return root ? herdrDirectoryIdentity(root) : null;
        }
        await Promise.all(listed.map(async (process, i) => {
          if (!process.identity) return;
          const cwd = process.identity.cwd;
          const identity = directories.get(cwd) ?? authorizedDirectory(cwd);
          directories.set(cwd, identity);
          const directoryId = await identity;
          if (directoryId) sessions[i]!.revision = herdrProcessRevision(processSalt, generation, process, directoryId);
        }));
        if (chatSelection === "gateway" && remoteWorktrees.length > 0 && sessions.length < HERDR_SESSION_LIST_MAX) {
          try {
            sessions.push(...await listRemoteChatSessions(HERDR_SESSION_LIST_MAX - sessions.length));
          } catch (error: unknown) {
            console.warn("[terminal-control] Remote listing unavailable", listingFailureKind(error));
          }
        }
      }
      return {
        available: true, status: "ready",
        sessions: typeof chatSelection === "function" ? sessions.filter(session => session.revision) : sessions,
      };
    } catch (error: unknown) {
      // A fixed kind, once per run of the same failure; the reason never reaches clients.
      const kind = listingFailureKind(error);
      if (kind !== loggedFailure) {
        loggedFailure = kind;
        console.warn("[herdr] terminal listing failed", kind);
      }
      return unavailable(coarse(host.status()));
    }
  }

  async function listEnrolledChatSessions(limit: number): Promise<HerdrSession[]> {
    try {
      const snapshot = await host.listEnrolledProcesses();
      return snapshot.terminals.filter((process) => process.selectionRevision).slice(0, limit).map(process => {
        const terminal = process.terminal;
        const separator = terminal.id.indexOf("/");
        return {
          id: terminal.id.slice(separator + 1), machine: terminal.id.slice(0, separator),
          tabId: enrolledChatRefs.remember(terminal.id).tabId, title: terminal.title, status: terminal.status,
          revision: process.selectionRevision!,
        };
      });
    } catch (error: unknown) {
      // Older Desktop clients deny the opt-in query. Their usual terminal list still works.
      if (!(error instanceof HcCallError && error.kind === "denied")) {
        console.warn("[terminal-control] Enrolled terminal listing unavailable", listingFailureKind(error));
      }
      return [];
    }
  }

  async function listRemoteChatSessions(limit: number, remember = true): Promise<HerdrSession[]> {
    const snapshot = await host.listRemoteProcesses();
    const sessions: HerdrSession[] = [];
    for (const route of remoteWorktrees) {
      const directory = await herdrDirectoryIdentity(route.localRoot);
      for (const process of snapshot.terminals) {
        if (sessions.length >= limit) return sessions;
        const revision = remoteTerminalRevision(processSalt, snapshot, process, route, directory);
        if (!revision) continue;
        const terminal = process.terminal;
        const ref = remember ? remoteChatRefs.remember(terminal.id) : herdrTerminalRef(terminal.id);
        sessions.push({ id: terminal.id.slice(route.machine.length + 1), machine: route.machine,
          tabId: ref.tabId, title: terminal.title, status: terminal.status, revision });
      }
    }
    return sessions;
  }

  async function discoverTerminals() {
    const snapshot = await host.discoverTerminals();
    if (!snapshot.machines.some(machine => machine.state === "connected")) return snapshot;
    let candidates: HerdrSession[] = [];
    if (remoteWorktrees.length > 0) {
      try {
        candidates = await listRemoteChatSessions(HERDR_SESSION_LIST_MAX, false);
      } catch (error: unknown) {
        console.warn("[terminal-control] Remote inventory unavailable", listingFailureKind(error));
      }
    }
    return {
      machines: snapshot.machines.map(machine => {
        if (machine.state !== "connected") return machine;
        const terminals = candidates.filter(session => session.machine === machine.name);
        return { ...machine, terminals, ...(terminals.length ? {} : { inventoryOnly: true as const }) };
      }),
    };
  }

  function noteEnded(sessions: HerdrSession[]): void {
    const at = now();
    const next = new Map(sessions.map((session) => [session.id, session.title]));
    for (const [id, title] of lastLive) {
      if (!next.has(id)) { ended.delete(id); ended.set(id, { tabId: herdrTerminalRef(id).tabId, title, at }); }
    }
    for (const id of next.keys()) ended.delete(id);
    for (const [id, entry] of ended) if (at - entry.at >= ENDED_TTL_MS) ended.delete(id);
    while (ended.size > MAX_ENDED) {
      const oldest = ended.keys().next().value;
      if (oldest === undefined) break;
      ended.delete(oldest);
    }
    lastLive = next;
  }

  function list(): Promise<HerdrSessionList> {
    if (closed) return Promise.resolve(unavailable("unavailable"));
    if (cache && now() - cache.at < ttlMs) return Promise.resolve(cache.value);
    listing ??= load().then((value) => {
      if (!closed) cache = { at: now(), value };
      return value;
    }).finally(() => { listing = null; });
    return listing;
  }

  /** Lists again now; a core that was missing or too old is dialed again. */
  async function refresh(): Promise<HerdrSessionList> {
    const status = host.status();
    if (status === "not-installed" || status === "unsupported" || status === "not-enabled") host.retry();
    cache = null;
    return list();
  }

  async function requireListed(id: string): Promise<void> {
    const listed = await list();
    if (!listed.available) throw new HerdrAdapterError("unavailable");
    if (!listed.sessions.some((session) => session.id === id)) throw new HerdrAdapterError("not_found");
  }

  function rememberSize(id: string, size: { cols: number; rows: number }): void {
    sizes.delete(id);
    sizes.set(id, size);
    while (sizes.size > MAX_REMEMBERED_SIZES) {
      const oldest = sizes.keys().next().value;
      if (oldest === undefined) break;
      sizes.delete(oldest);
    }
  }

  async function attach(
    id: string, size: { cols: number; rows: number }, handlers: HerdrAttachmentHandlers,
    stream: HcAttachOptions = {},
  ): Promise<HerdrAttachment> {
    if (closed) throw new HerdrAdapterError("unavailable");
    let attachId: number;
    try {
      attachId = await host.attach(id, size, stream);
    } catch (error: unknown) {
      if (error instanceof Error && error.message === "too many terminal attachments") throw new HerdrAdapterError("capacity");
      // Listed a moment ago, but the core says it is gone or has finished.
      if (error instanceof HcCallError && (error.kind === "not_found" || error.kind === "finished")) throw new HerdrAdapterError("not_found");
      throw error;
    }
    let ended = false;
    viewers.set(attachId, { output: handlers.output, closed: (reason) => { ended = true; handlers.closed(reason); } });
    for (const entry of early.get(attachId) ?? []) {
      if ("data" in entry) handlers.output(entry.data, () => { host.acknowledge(attachId, 1); });
      else if (viewers.delete(attachId)) { ended = true; handlers.closed(entry.closed); }
    }
    early.delete(attachId);
    return {
      input: (data, binary = false) => !ended && host.input(attachId, data, binary),
      resize: (cols, rows) => {
        if (ended) return false;
        rememberSize(id, { cols, rows });
        return host.resize(attachId, { cols, rows });
      },
      detach: () => {
        if (ended) return;
        ended = true;
        viewers.delete(attachId);
        host.detach(attachId);
      },
    };
  }

  /** The capture grid: CAPTURE_SIZE, widened to the last writer's size, never past CAPTURE_MAX_SIZE. */
  function captureSize(id: string): { cols: number; rows: number } {
    const writer = sizes.get(id);
    return {
      cols: Math.min(CAPTURE_MAX_SIZE.cols, Math.max(CAPTURE_SIZE.cols, writer?.cols ?? 0)),
      rows: Math.min(CAPTURE_MAX_SIZE.rows, Math.max(CAPTURE_SIZE.rows, writer?.rows ?? 0)),
    };
  }

  async function render(id: string, lines: number, stream?: HcAttachOptions): Promise<HerdrScreen> {
    const chunks: string[] = [];
    let total = 0;
    let lastOutputAt = 0;
    let ended = false;
    const size = captureSize(id);
    const attachment = await attach(id, size, {
      output: (data, consumed) => {
        if (total < CAPTURE_MAX_CHARS) { chunks.push(data); total += data.length; }
        lastOutputAt = Date.now();
        consumed();
      },
      closed: () => { ended = true; },
    // Watch only: the core never sizes the program to a read's grid.
    }, { ...stream, history: lines, observe: true });
    const started = Date.now();
    try {
      // The paint arrives in a burst; it is complete once the stream goes quiet.
      while (!ended && Date.now() - started < captureMaxMs) {
        const quietFor = Date.now() - (lastOutputAt || started);
        if (quietFor >= captureQuietMs && (lastOutputAt > 0 || quietFor >= captureQuietMs * 2)) break;
        await new Promise((resolve) => setTimeout(resolve, Math.max(1, Math.min(captureQuietMs, 25))));
      }
    } finally {
      attachment.detach();
    }
    const terminal = new HeadlessTerminal({ ...size, scrollback: lines, allowProposedApi: true });
    try {
      await new Promise<void>((resolve) => { terminal.write(chunks.join(""), resolve); });
      const buffer = terminal.buffer.active;
      const rows: string[] = [];
      for (let index = 0; index < buffer.length; index += 1) rows.push(buffer.getLine(index)?.translateToString(true) ?? "");
      const viewport = rows.slice(buffer.baseY);
      while (viewport.length > 0 && viewport[viewport.length - 1] === "") viewport.pop();
      return { viewport, scrollback: trimHistory(rows.slice(0, buffer.baseY), lines) };
    } finally {
      terminal.dispose();
    }
  }

  async function workspace(): Promise<TerminalWorkspace | null> {
    const listed = await list();
    if (!listed.available) return null;
    const finished = [...ended.values()].filter((entry) => now() - entry.at < ENDED_TTL_MS);
    if (listed.sessions.length === 0 && finished.length === 0) return null;
    return workspaceWithTabs(listed.sessions.map((session, order) => liveTab(session.tabId, session.title, order))
      .concat(finished.map((entry, index): TerminalWorkspace["tabs"][number] => ({
        ...liveTab(entry.tabId, entry.title, listed.sessions.length + index),
        // herdr-core's listing gives no exit code for a terminal that is gone.
        status: "exited",
        exitCode: null,
      }))));
  }

  function workspaceWithTabs(tabs: TerminalWorkspace["tabs"]): TerminalWorkspace {
    return {
      id: HERDR_TERMINAL_WORKSPACE_ID,
      scope: "main",
      canonicalSize: DEFAULT_INPUT_SIZE,
      status: "running",
      revision: 0,
      createdAt: WORKSPACE_CREATED_AT,
      updatedAt: WORKSPACE_CREATED_AT,
      tabs,
    };
  }

  function liveTab(tabId: string, title: string, order: number): TerminalWorkspace["tabs"][number] {
    return {
      id: tabId, workspaceId: HERDR_TERMINAL_WORKSPACE_ID, name: displayName(title),
      cwd: "", status: "running", revision: 0, order, accessScope: "owner",
      createdAt: WORKSPACE_CREATED_AT, updatedAt: WORKSPACE_CREATED_AT,
    };
  }

  const currentChatGeneration = (generation: number) =>
    !closed && !connectionDown && host.isCurrentGeneration(generation);

  const discardOutput: HerdrAttachmentHandlers = {
    output: (_data, consumed) => consumed(), closed: () => undefined,
  };

  async function bindRemoteChatTerminal(ref: TerminalRef, root: string, selection: ChatTerminalSelection) {
    const id = remoteChatRefs.resolve(ref);
    if (!id || selection.signal.aborted) return null;
    const [machine] = id.split("/");
    const worktree = remoteWorktrees.find(row => row.machine === machine && row.worktreeId === selection.worktreeId && row.localRoot === root);
    if (!worktree) return null;
    const inspect = async () => {
      const snapshot = await host.listRemoteProcesses();
      const directory = await herdrDirectoryIdentity(root);
      const terminals = snapshot.terminals.filter(process => process.terminal.id === id).flatMap(process => {
        const revision = remoteTerminalRevision(processSalt, snapshot, process, worktree, directory);
        return revision ? [{ ...process, selectionRevision: revision }] : [];
      });
      return { generation: snapshot.generation, terminals };
    };
    const initial = await inspect();
    const [process] = initial.terminals;
    if (initial.terminals.length !== 1 || !process || process.selectionRevision !== selection.revision) return null;
    let attachmentCurrent = true;
    const matchesAttachment = acceptRemoteAttachment(process);
    const stream = { acceptTerminal: (terminal: unknown) => {
      attachmentCurrent &&= matchesAttachment(terminal);
      return attachmentCurrent;
    } };
    return bindHerdrChatTerminal({
      salt: processSalt,
      qualifiedRemote: true,
      inspect,
      current: generation => attachmentCurrent && generation === initial.generation && currentChatGeneration(generation),
      workspace: async () => workspaceWithTabs([liveTab(ref.tabId, process.terminal.title, 0)]),
      screen: (terminalId, lines) => render(terminalId, lines, stream),
      writer: terminalId => attach(terminalId, sizes.get(terminalId) ?? DEFAULT_INPUT_SIZE, discardOutput, stream),
    }, id, ref, root, selection);
  }

  async function bindEnrolledChatTerminal(ref: TerminalRef, localRef: TerminalRef, root: string, selection: ChatTerminalSelection) {
    const id = enrolledChatRefs.resolve(localRef);
    if (!id || !selection.desktop || selection.signal.aborted) return null;
    const first = await host.listEnrolledProcesses();
    const selected = first.terminals.filter(process => process.terminal.id === id && process.selectionRevision === selection.revision);
    const [process] = selected;
    if (selected.length !== 1 || !process) return null;
    const stream = { selectionRevision: selection.revision, remoteScope: randomBytes(32).toString("hex") };
    const tab = { ...liveTab(ref.tabId, process.terminal.title, 0), workspaceId: ref.workspaceId };
    return bindHerdrChatTerminal({
      salt: processSalt,
      qualifiedRemote: true,
      inspect: () => host.listEnrolledProcesses(),
      current: generation => generation === first.generation && currentChatGeneration(generation),
      workspace: async () => ({ ...workspaceWithTabs([tab]), id: ref.workspaceId }),
      screen: (terminalId, lines) => render(terminalId, lines, stream),
      writer: terminalId => attach(terminalId, sizes.get(terminalId) ?? DEFAULT_INPUT_SIZE, discardOutput, stream),
    }, id, ref, root, selection);
  }

  function bindLocalChatTerminal(
    id: string, ref: TerminalRef, executionRoot: string, selection: ChatTerminalSelection,
    stream: HcAttachOptions, current = currentChatGeneration,
  ) {
    return bindHerdrChatTerminal({
      salt: processSalt,
      inspect: () => host.listProcesses(),
      current,
      workspace: async () => {
        const source = await workspace();
        if (!source || !selection.desktop) return source;
        return { ...source, id: ref.workspaceId, tabs: source.tabs.map(tab => ({ ...tab, workspaceId: ref.workspaceId })) };
      },
      screen: (terminalId, lines) => render(terminalId, lines, stream),
      writer: terminalId => attach(terminalId, sizes.get(terminalId) ?? DEFAULT_INPUT_SIZE, discardOutput, stream),
    }, id, ref, executionRoot, selection);
  }

  return {
    list,
    discoverTerminals,
    listForChatControl: () => load("gateway"),
    listForLinkedChatControl: () => load("desktop"),
    listForManagedChatControl: (resolveRoot: ManagedTerminalRootResolver) => load(resolveRoot),
    refresh,

    /** Lists on start and every 30 s, so status and attention stay current without a viewer. */
    start(): void {
      if (timer || closed) return;
      void refresh();
      timer = setInterval(() => { void refresh(); }, options.refreshMs ?? DEFAULT_REFRESH_MS);
      timer.unref?.();
    },

    /** The herdr id behind a Matrix terminal ref, if it is a Herdr terminal seen recently. */
    resolve: (ref: TerminalRef): string | undefined => refs.resolve(ref),

    /** The Herdr terminals as one canonical workspace, or null when there are none to show. */
    workspace,

    async bindChatTerminal(ref: TerminalRef, executionRoot: string, selection: ChatTerminalSelection) {
      const localRef = selection.desktop ? { ...ref, workspaceId: HERDR_TERMINAL_WORKSPACE_ID } : ref;
      const id = refs.resolve(localRef);
      if (!id) return selection.desktop
        ? bindEnrolledChatTerminal(ref, localRef, executionRoot, selection)
        : bindRemoteChatTerminal(ref, executionRoot, selection);
      const stream = { selectionRevision: selection.desktop ? selection.revision : undefined };
      return bindLocalChatTerminal(id, ref, executionRoot, selection, stream);
    },

    async bindManagedChatTerminal(
      ref: TerminalRef, selection: Omit<ChatTerminalSelection, "desktop" | "worktreeId" | "validateRoot">,
      resolveRoot: ManagedTerminalRootResolver,
    ) {
      const id = refs.resolve(ref);
      if (!id || selection.signal.aborted) return null;
      const initial = await host.listProcesses();
      const selected = initial.terminals.filter(process => process.terminal.id === id);
      const process = selected[0];
      if (selected.length !== 1 || !process?.identity) return null;
      const root = await resolveRoot(process.identity.cwd);
      if (!root || selection.signal.aborted) return null;
      let attachmentCurrent = true;
      const matchesAttachment = acceptRemoteAttachment(process);
      return bindLocalChatTerminal(
        id, ref, root, { ...selection, validateRoot: async () => await resolveRoot(root) === root },
        { acceptTerminal: (terminal: unknown) => {
          attachmentCurrent &&= matchesAttachment(terminal);
          return attachmentCurrent;
        } },
        generation => attachmentCurrent && generation === initial.generation && currentChatGeneration(generation),
      );
    },

    /** Herdr's own status reports, in the terminal-agent status pipeline's shape. */
    async statuses(): Promise<TerminalAgentStatusEntry[]> {
      const listed = await list();
      return listed.sessions.flatMap((session) => {
        const entry = reported.get(session.id);
        if (!session.status || !entry) return [];
        return [{
          ref: { workspaceId: HERDR_TERMINAL_WORKSPACE_ID, tabId: session.tabId },
          status: session.status,
          ...(entry.message ? { message: entry.message } : {}),
          reportedAt: new Date(entry.at).toISOString(),
          source: "reporter" as const,
        }];
      });
    },

    attach,

    /** A writer's size for this terminal, so verb input attaches at the same size. */
    rememberSize,

    /**
     * Starts a terminal: the computer's shell at home, or `launch` there.
     * Returns its id, or null when too many were started just now.
     */
    async create(size: { cols: number; rows: number }, launch: HerdrLaunch = {}): Promise<string | null> {
      if (closed) throw new HerdrAdapterError("unavailable");
      const id = await host.create(size, launch);
      cache = null;
      return id;
    },

    async kill(id: string): Promise<void> {
      await requireListed(id);
      await host.kill(id);
      cache = null;
    },

    /** The screen and up to `lines` of history, rendered from the core's paint. */
    async captureScreen(id: string, lines: number): Promise<HerdrScreen> {
      await requireListed(id);
      const depth = Math.min(CAPTURE_MAX_SCROLLBACK, Math.max(0, Math.trunc(lines)));
      const cached = captures.get(id);
      // A recent read at least this deep answers it; a deeper request reads again.
      if (cached && now() - cached.at < CAPTURE_CACHE_MS && cached.lines >= depth) {
        return cached.screen.then((screen) => ({ viewport: screen.viewport, scrollback: trimHistory(screen.scrollback, depth) }));
      }
      const screen = render(id, depth);
      captures.set(id, { at: now(), lines: depth, screen });
      // At most one entry per listed terminal.
      for (const key of [...captures.keys()]) if (key !== id && now() - captures.get(key)!.at >= CAPTURE_CACHE_MS) captures.delete(key);
      screen.then(undefined, () => { if (captures.get(id)?.screen === screen) captures.delete(id); });
      return screen;
    },

    /** Types into a terminal through a short attachment at the size a Matrix writer last used. */
    async writeInput(id: string, data: string): Promise<void> {
      await requireListed(id);
      const attachment = await attach(id, sizes.get(id) ?? DEFAULT_INPUT_SIZE, {
        output: (_data, consumed) => consumed(),
        closed: () => undefined,
      });
      try {
        if (!attachment.input(data)) throw new HerdrAdapterError("not_found");
      } finally {
        attachment.detach();
      }
      captures.delete(id);
    },

    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      if (timer) clearInterval(timer);
      timer = null;
      cache = null;
      const open = [...viewers.values()];
      viewers.clear();
      early.clear();
      captures.clear();
      host.dispose();
      for (const viewer of open) viewer.closed("disconnected");
      options.closeTransport?.();
    },
  };
}

export type HerdrAdapter = ReturnType<typeof createHerdrAdapter>;
