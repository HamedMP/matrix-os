// Herdr sessions in Matrix (spec 2701 layer 2): the terminals held by the
// owner's own herdr-core, reached through `herdr-core connect`. The core is
// the owner's, not Matrix's: the adapter lists, attaches, types into and ends
// its terminals, and does nothing else to it.
import headless from "@xterm/headless";
import type { TerminalRef, TerminalWorkspace } from "@matrix-os/contracts";
import { SafeDisplayStringSchema } from "@matrix-os/contracts";
import {
  HERDR_SESSION_LIST_MAX, HERDR_TERMINAL_WORKSPACE_ID,
  type HerdrAvailability, type HerdrSession, type HerdrSessionList,
} from "@matrix-os/contracts/herdr-terminals";
import type { HcSocket } from "@matrix-os/herdr-core-client/client";
import { createAttachmentSlots } from "@matrix-os/herdr-core-client/sessions";
import { createHerdrSessionHost, type HerdrSessionHostStatus } from "@matrix-os/herdr-core-client/session-host";
import type { TerminalAgentStatusEntry } from "@matrix-os/terminal-runtime";
import { createHerdrRefMap } from "./refs.js";

const { Terminal: HeadlessTerminal } = headless;

const DEFAULT_TTL_MS = 2_000;
const DEFAULT_REFRESH_MS = 30_000;
/** Attachments across every viewer and verb; each WS viewer holds one. */
export const HERDR_MAX_ATTACHMENTS = 32;
// A read attaches as an observer and renders the core's paint on a grid large
// enough that the core's own screen is not wrapped or clipped.
const CAPTURE_SIZE = { cols: 300, rows: 100 };
const CAPTURE_MAX_SCROLLBACK = 10_000;
const CAPTURE_MAX_CHARS = 8 * 1024 * 1024;
const DEFAULT_CAPTURE_QUIET_MS = 120;
const DEFAULT_CAPTURE_MAX_MS = 1_500;
const CAPTURE_CACHE_MS = 400;
const DEFAULT_INPUT_SIZE = { cols: 120, rows: 36 };
const MAX_REMEMBERED_SIZES = 1_024;
const MAX_EARLY_OUTPUT = 64;
const WORKSPACE_CREATED_AT = new Date(0).toISOString();

export interface HerdrAttachmentHandlers {
  /** Call `consumed` once the output has really been taken; until then the core slows down. */
  output(data: string, consumed: () => void): void;
  closed(): void;
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
}) {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const captureQuietMs = options.captureQuietMs ?? DEFAULT_CAPTURE_QUIET_MS;
  const captureMaxMs = options.captureMaxMs ?? DEFAULT_CAPTURE_MAX_MS;
  const refs = createHerdrRefMap();
  // Bounded by the attachment slots; entries leave on detach and close.
  const viewers = new Map<number, HerdrAttachmentHandlers>();
  // Output can arrive in the same read as the attach answer, before the
  // attachment id is known here. Bounded; ids are never reused.
  const early = new Map<number, Array<{ data: string } | { closed: true }>>();
  // Last size a Matrix writer used per terminal, so a verb's short attachment does not fight it. LRU-bounded.
  const sizes = new Map<string, { cols: number; rows: number }>();
  // Status words with the time each was first seen; pruned to listed terminals.
  const reported = new Map<string, { status: string; message?: string; at: number }>();
  const captures = new Map<string, { at: number; screen: Promise<HerdrScreen> }>();
  let cache: { at: number; value: HerdrSessionList } | null = null;
  let listing: Promise<HerdrSessionList> | null = null;
  let closed = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const host = createHerdrSessionHost({
    open: options.open,
    slots: createAttachmentSlots(HERDR_MAX_ATTACHMENTS),
    now,
    ...(options.random ? { random: options.random } : {}),
  }, {
    output(attachId, data) {
      const viewer = viewers.get(attachId);
      if (viewer) { viewer.output(data, () => { host.acknowledge(attachId, 1); }); return; }
      queueEarly(attachId, { data });
    },
    closed(attachId) {
      const viewer = viewers.get(attachId);
      if (viewer) { viewers.delete(attachId); viewer.closed(); return; }
      queueEarly(attachId, { closed: true });
    },
  });

  function queueEarly(attachId: number, entry: { data: string } | { closed: true }): void {
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

  async function load(): Promise<HerdrSessionList> {
    if (closed) return unavailable("unavailable");
    try {
      const terminals = (await host.list()).slice(0, HERDR_SESSION_LIST_MAX);
      const live = new Set<string>();
      const sessions: HerdrSession[] = terminals.map((terminal) => {
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
      return { available: true, status: "ready", sessions };
    } catch (error: unknown) {
      // The host logs the failure's kind; the reason never reaches clients.
      void error;
      return unavailable(coarse(host.status()));
    }
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

  async function attach(id: string, size: { cols: number; rows: number }, handlers: HerdrAttachmentHandlers): Promise<HerdrAttachment> {
    if (closed) throw new HerdrAdapterError("unavailable");
    let attachId: number;
    try {
      attachId = await host.attach(id, size);
    } catch (error: unknown) {
      if (error instanceof Error && error.message === "too many terminal attachments") throw new HerdrAdapterError("capacity");
      throw error;
    }
    let ended = false;
    viewers.set(attachId, { output: handlers.output, closed: () => { ended = true; handlers.closed(); } });
    for (const entry of early.get(attachId) ?? []) {
      if ("data" in entry) handlers.output(entry.data, () => { host.acknowledge(attachId, 1); });
      else if (viewers.delete(attachId)) { ended = true; handlers.closed(); }
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

  async function render(id: string, lines: number): Promise<HerdrScreen> {
    const chunks: string[] = [];
    let total = 0;
    let lastOutputAt = 0;
    let ended = false;
    const attachment = await attach(id, CAPTURE_SIZE, {
      output: (data, consumed) => {
        if (total < CAPTURE_MAX_CHARS) { chunks.push(data); total += data.length; }
        lastOutputAt = Date.now();
        consumed();
      },
      closed: () => { ended = true; },
    });
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
    const terminal = new HeadlessTerminal({ ...CAPTURE_SIZE, scrollback: Math.min(CAPTURE_MAX_SCROLLBACK, Math.max(lines, 0)), allowProposedApi: true });
    try {
      await new Promise<void>((resolve) => { terminal.write(chunks.join(""), resolve); });
      const buffer = terminal.buffer.active;
      const rows: string[] = [];
      for (let index = 0; index < buffer.length; index += 1) rows.push(buffer.getLine(index)?.translateToString(true) ?? "");
      const viewport = rows.slice(buffer.baseY);
      while (viewport.length > 0 && viewport[viewport.length - 1] === "") viewport.pop();
      return { viewport, scrollback: rows.slice(0, buffer.baseY).slice(-Math.max(lines, 0) || rows.length) };
    } finally {
      terminal.dispose();
    }
  }

  return {
    list,
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
    async workspace(): Promise<TerminalWorkspace | null> {
      const listed = await list();
      if (!listed.available || listed.sessions.length === 0) return null;
      return {
        id: HERDR_TERMINAL_WORKSPACE_ID,
        scope: "main",
        canonicalSize: DEFAULT_INPUT_SIZE,
        status: "running",
        revision: 0,
        createdAt: WORKSPACE_CREATED_AT,
        updatedAt: WORKSPACE_CREATED_AT,
        tabs: listed.sessions.map((session, order) => ({
          id: session.tabId,
          workspaceId: HERDR_TERMINAL_WORKSPACE_ID,
          name: displayName(session.title),
          cwd: "",
          status: "running",
          revision: 0,
          order,
          accessScope: "owner",
          createdAt: WORKSPACE_CREATED_AT,
          updatedAt: WORKSPACE_CREATED_AT,
        })),
      };
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

    async kill(id: string): Promise<void> {
      await requireListed(id);
      await host.kill(id);
      cache = null;
    },

    /** The screen and up to `lines` of history, rendered from the core's paint. */
    async captureScreen(id: string, lines: number): Promise<HerdrScreen> {
      await requireListed(id);
      const cached = captures.get(id);
      if (cached && now() - cached.at < CAPTURE_CACHE_MS) return cached.screen;
      const screen = render(id, lines);
      captures.set(id, { at: now(), screen });
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
      for (const viewer of open) viewer.closed();
      options.closeTransport?.();
    },
  };
}

export type HerdrAdapter = ReturnType<typeof createHerdrAdapter>;
