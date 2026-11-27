// What every herdr-core session has in common, whichever core it is and
// however it is reached: listing, starting, ending, and attachments with
// output acknowledgement and flow control. The local terminal host and the
// Herdr session host are both built on this (spec 651 FR-016).
import { z } from "zod/v4";
import {
  HC_TERMINAL_ADDRESS_PATTERN as LOCAL_TERMINAL_ADDRESS_PATTERN, HC_TERMINAL_ID_PATTERN as LOCAL_TERMINAL_ID_PATTERN,
  HC_TERMINAL_LIST_MAX as LOCAL_TERMINAL_LIST_MAX, HC_TERMINAL_MAX_OUTPUT_CHARS as LOCAL_TERMINAL_MAX_OUTPUT_CHARS,
  HcTerminalStatusSchema as LocalTerminalStatusSchema, type HcTerminal as LocalTerminal,
} from "#terminal";
import type { HcConnection, HcStream } from "#client";
import type { HcDisplayFacts } from "#protocol";

// Every pane of the Terminal window streams live: a full tab of 16 panes, plus
// room for the panes of the tab being switched to and the main window's terminals.
export const DEFAULT_MAX_ATTACHMENTS = 24;
// Terminal creation is rate-limited, never count-capped.
const CREATE_WINDOW_MS = 10_000;
const MAX_CREATES_PER_WINDOW = 10;
const MAX_TITLE_CHARS = 256;
// Each entry is read on its own: a terminal the core describes in a way this
// build does not expect is skipped instead of hiding every other terminal.
const ListedSchema = z.object({ terminals: z.array(z.unknown()).max(LOCAL_TERMINAL_LIST_MAX) });
const ProcessIdentitySchema = z.object({
  cwd: z.string().min(1).max(4096), pid: z.int().positive(), created_ms: z.int().nonnegative(),
});
export type HcListedProcess = { terminal: LocalTerminal; identity?: z.infer<typeof ProcessIdentitySchema>; selectionRevision?: string };
export interface HcAttachOptions {
  history?: number;
  observe?: boolean;
  selectionRevision?: string;
  remoteScope?: string;
  acceptTerminal?(terminal: unknown): boolean;
}

const ListedTerminalSchema = z.object({
  address: z.string().regex(LOCAL_TERMINAL_ID_PATTERN),
  state: z.string().max(32),
  // Titles and status come from the program in the terminal: anything goes in,
  // only bounded printable text and a known state come out.
  title: z.string().nullable().optional().catch(null),
  name: z.string().nullable().optional().catch(null),
  status: z.object({ state: z.string().max(32), msg: z.string().optional().catch(undefined) }).nullable().optional().catch(null),
  labels: z.record(z.string(), z.string()).nullable().optional().catch(null),
  selection_revision: z.string().regex(/^[a-f0-9]{64}$/).optional().catch(undefined),
  argv: z.array(z.string()).max(4_096).nullable().optional().catch(null),
});
// terminal.list includes remote lines and machine presence in the same snapshot.
const DiscoverySchema = ListedSchema.extend({ machines: z.array(z.unknown()).max(1_000).optional() });
const DiscoveryTerminalSchema = ListedTerminalSchema.extend({ address: z.string().regex(LOCAL_TERMINAL_ADDRESS_PATTERN) });
const MachinePresenceSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,31}$/), state: z.string().max(32),
});
const ConnectedMachinesSchema = z.object({
  machines: z.array(MachinePresenceSchema.extend({ id: z.string().regex(/^[0-9a-f]{32}$/).optional().catch(undefined) })).max(1_000),
});

export function parseRegisteredMachines(reply: unknown) {
  return ConnectedMachinesSchema.parse(reply).machines;
}
export interface DiscoveredMachine {
  id: string;
  name: string;
  online: boolean;
  /** Reachability of this named route as reported by the core. */
  state?: "connected" | "unreachable" | "unknown";
  terminals: Array<Pick<LocalTerminal, "id" | "title" | "status">>;
}

/** The label `hc run --label where=…` sets; Herdr shows it as the terminal's place. */
const WHERE_LABEL = "where";
/** The label a rename sets; it wins over the program's own title. */
export const TERMINAL_TITLE_LABEL = "matrix.title";
const PutResultSchema = z.object({ path: z.string().min(1).max(4096) });
// A terminal started on an added machine has that machine's address (`vps/t7`).
const RanSchema = z.object({ address: z.string().regex(LOCAL_TERMINAL_ADDRESS_PATTERN) });
// Control characters and bidirectional overrides can disguise a title.
const UNSAFE_TITLE_CHARS = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

function safeStatusMessage(value: string): string {
  return value.replace(UNSAFE_TITLE_CHARS, "").trim().slice(0, 200);
}

function programName(command: string | undefined): string | undefined {
  return command?.slice(command.lastIndexOf("/") + 1);
}

export function safeTerminalTitle(...candidates: Array<string | null | undefined>): string {
  for (const candidate of candidates) {
    const title = candidate?.replace(UNSAFE_TITLE_CHARS, "").trim().slice(0, MAX_TITLE_CHARS);
    if (title) return title;
  }
  return "Terminal";
}

function terminalTitle(terminal: z.infer<typeof ListedTerminalSchema>): string {
  return safeTerminalTitle(terminal.labels?.[TERMINAL_TITLE_LABEL], terminal.title, terminal.name,
    terminal.labels?.[WHERE_LABEL], programName(terminal.argv?.[0]));
}

/** Discovery does not add addresses to any local control or attachment registry. */
export function discoverHerdrMachines(reply: unknown): { machines: DiscoveredMachine[] } {
  const snapshot = DiscoverySchema.parse(reply);
  const local: DiscoveredMachine = { id: "gateway", name: "Current Matrix computer", online: true, terminals: [] };
  const remotes = new Map<string, DiscoveredMachine>();
  for (const raw of snapshot.machines ?? []) {
    const machine = MachinePresenceSchema.safeParse(raw);
    if (!machine.success) continue;
    const { name, state } = machine.data;
    remotes.set(name, { id: `herdr:${name}`, name, online: state === "connected",
      state: state === "connected" || state === "unreachable" ? state : "unknown", terminals: [] });
  }
  for (const raw of snapshot.terminals) {
    const row = DiscoveryTerminalSchema.safeParse(raw);
    if (!row.success || row.data.state !== "live") continue;
    const address = row.data.address;
    const separator = address.indexOf("/");
    const machine = separator < 0 ? local : remotes.get(address.slice(0, separator));
    if (!machine?.online) continue;
    const status = LocalTerminalStatusSchema.safeParse(row.data.status?.state);
    machine.terminals.push({ id: address.slice(separator + 1), title: terminalTitle(row.data), status: status.success ? status.data : null });
  }
  return { machines: [local, ...remotes.values()] };
}

/**
 * The window's budget of live attachments. One set of slots can be shared by
 * several hosts, so the budget holds across them and no attachment id is ever
 * used twice.
 */
export interface AttachmentSlots {
  /** An unused attachment id, or null when every slot is taken. */
  acquire(): number | null;
  release(attachId: number): void;
}

export function createAttachmentSlots(max = DEFAULT_MAX_ATTACHMENTS): AttachmentSlots {
  // Bounded by `max`; entries leave on release.
  const held = new Set<number>();
  let next = 1;
  return {
    acquire() {
      if (held.size >= max) return null;
      const attachId = next++;
      held.add(attachId);
      return attachId;
    },
    release(attachId) { held.delete(attachId); },
  };
}

export interface HcSessionSink {
  /** Output as text, decoded and cut into slices of at most HC_TERMINAL_MAX_OUTPUT_CHARS. */
  output?(attachId: number, data: string): void;
  /**
   * Output as the core sent it, one call per chunk, never decoded. The bytes
   * are a view of the socket read and valid only during the call: copy or
   * post them before returning. When present, `output` is not used.
   */
  outputBytes?(attachId: number, data: Uint8Array): void;
  closed(attachId: number): void;
}

interface Attachment {
  stream: HcStream | null;
  /**
   * One entry per output event sent to the window and not yet acknowledged:
   * the credit to return for it, or null for a part of a larger chunk. The
   * core stops sending when its window is spent, which bounds this queue.
   */
  unacknowledged: Array<(() => void) | null>;
}

export function createHcSessions(options: {
  /** The live connection, opened on demand. Rejects when the core cannot be reached. */
  ensure(): Promise<HcConnection>;
  slots?: AttachmentSlots;
  now?: () => number;
}, sink: HcSessionSink) {
  const now = options.now ?? Date.now;
  const slots = options.slots ?? createAttachmentSlots();
  // Bounded by the slots; cleared when the connection is lost and on drop.
  const attachments = new Map<number, Attachment>();
  // Start times of recent creations: at most MAX_CREATES_PER_WINDOW entries.
  let creates: number[] = [];
  // Changes whenever every attachment is released (the window closed,
  // reloaded or crashed). An attach that started before that belongs to a
  // window that is gone and must not complete.
  let releaseEpoch = 0;
  // Creations run one at a time, so the rate limit counts them in order.
  let creation: Promise<unknown> = Promise.resolve();

  function forget(attachId: number): Attachment | null {
    const attachment = attachments.get(attachId);
    if (!attachment) return null;
    attachments.delete(attachId);
    slots.release(attachId);
    return attachment;
  }

  function release(attachId: number): boolean {
    const attachment = forget(attachId);
    attachment?.stream?.close();
    return attachment != null;
  }

  async function start(params: Record<string, unknown>, deadline: number | undefined): Promise<string | null> {
    // Starts run one at a time; one that waited past its caller's deadline is never sent,
    // and the core gets only the time it has left.
    const left = deadline === undefined ? undefined : deadline - now();
    if (left !== undefined && left <= 0) throw new Error("terminal start expired");
    const core = await options.ensure();
    const time = now();
    creates = creates.filter((started) => time - started < CREATE_WINDOW_MS);
    if (creates.length >= MAX_CREATES_PER_WINDOW) return null;
    creates.push(time);
    const remaining = deadline === undefined ? undefined : deadline - now();
    if (remaining !== undefined && remaining <= 0) throw new Error("terminal start expired");
    return RanSchema.parse(await core.call("terminal.run", params, remaining)).address;
  }

  /** Process metadata is internal. Never return it as the renderer's terminal listing. */
  async function listProcesses(core: HcConnection, scope?: "remote" | "enrolled"): Promise<HcListedProcess[]> {
    const listed = ListedSchema.parse(await core.call("terminal.list", scope === "enrolled" ? { enrolled: true } : {}));
    const terminals: HcListedProcess[] = [];
    for (const entry of listed.terminals) {
      const terminal = (scope ? DiscoveryTerminalSchema : ListedTerminalSchema).safeParse(entry);
      if (!terminal.success || terminal.data.state !== "live") continue;
      if (scope && !terminal.data.address.includes("/")) continue;
      const state = LocalTerminalStatusSchema.safeParse(terminal.data.status?.state);
      const identity = ProcessIdentitySchema.safeParse(entry);
      terminals.push({ terminal: {
        id: terminal.data.address,
        // Terminals started from Herdr often carry no title of their own; its
        // where label, then the program's name, tell them apart.
        title: terminalTitle(terminal.data),
        status: state.success ? state.data : null,
        ...(state.success && terminal.data.status?.msg ? { statusMessage: safeStatusMessage(terminal.data.status.msg) } : {}),
      }, ...(identity.success ? { identity: identity.data } : {}), ...(terminal.data.selection_revision ? { selectionRevision: terminal.data.selection_revision } : {}) });
    }
    return terminals;
  }

  return {
    /** How many attachments are open. */
    attached: (): number => attachments.size,

    async list(): Promise<LocalTerminal[]> {
      return (await listProcesses(await options.ensure())).map(({ terminal }) => terminal);
    },
    listProcesses,

    /** Starts a terminal with these `terminal.run` params. Returns null when too many were started just now. */
    run(params: Record<string, unknown>, timing: { deadlineMs?: number } = {}): Promise<string | null> {
      const deadline = timing.deadlineMs === undefined ? undefined : now() + timing.deadlineMs;
      const next = creation.then(() => start(params, deadline));
      // The chain itself never rejects; each caller still sees and handles its own
      // outcome through `next`, so the chain only keeps the order.
      creation = next.then(() => undefined, (error: unknown) => { void error; });
      return next;
    },

    /** Names a terminal for every client of this core: a label, so the program's own title stays. */
    async rename(id: string, name: string): Promise<void> {
      const core = await options.ensure();
      await core.call("terminal.label", { terminal: id, labels: { [TERMINAL_TITLE_LABEL]: safeTerminalTitle(name) } });
    },

    /** Writes a pasted file beside the terminal, on its machine; returns where it landed. */
    async put(id: string, name: string, dataBase64: string): Promise<string> {
      const core = await options.ensure();
      return PutResultSchema.parse(await core.call("terminal.put", { terminal: id, name, data: dataBase64 })).path;
    },

    async kill(id: string): Promise<void> {
      const core = await options.ensure();
      await core.call("terminal.kill", { terminal: id });
    },

    /**
     * `stream.history`: scrollback lines the core replays first (2,000 when omitted).
     * `stream.observe`: watch only; the core never takes this viewer's typing or size.
     */
    async attach(id: string, size: { cols: number; rows: number }, stream: HcAttachOptions = {}): Promise<number> {
      const startedIn = releaseEpoch;
      const core = await options.ensure();
      if (releaseEpoch !== startedIn) throw new Error("terminal attachment ended");
      const attachId = slots.acquire();
      if (attachId === null) throw new Error("too many terminal attachments");
      const decoder = new TextDecoder("utf-8");
      // Registered before the core answers: output and even the end of the
      // terminal can arrive in the same read as the answer.
      const attachment: Attachment = { stream: null, unacknowledged: [] };
      attachments.set(attachId, attachment);
      try {
        attachment.stream = await core.attach({
          terminal: id, ...size,
          ...(stream.history === undefined ? {} : { history: stream.history }),
          // Sent only when set, so a typing attach looks exactly as before.
          ...(stream.observe ? { observe: true } : {}),
          ...(stream.selectionRevision ? { selection_revision: stream.selectionRevision } : {}),
          ...(stream.remoteScope ? { remote_scope: stream.remoteScope } : {}),
        }, {
          acceptTerminal: stream.acceptTerminal,
          onData: (chunk, consumed) => {
            if (sink.outputBytes) {
              attachment.unacknowledged.push(consumed);
              sink.outputBytes(attachId, chunk);
              return;
            }
            if (!sink.output) { consumed(); return; }
            const text = decoder.decode(chunk, { stream: true });
            if (text.length === 0) { consumed(); return; }
            for (let offset = 0; offset < text.length; offset += LOCAL_TERMINAL_MAX_OUTPUT_CHARS) {
              const last = offset + LOCAL_TERMINAL_MAX_OUTPUT_CHARS >= text.length;
              attachment.unacknowledged.push(last ? consumed : null);
              sink.output(attachId, text.slice(offset, offset + LOCAL_TERMINAL_MAX_OUTPUT_CHARS));
            }
          },
          onClose: () => { if (forget(attachId)) sink.closed(attachId); },
        });
      } catch (error: unknown) {
        if (attachments.get(attachId) === attachment) forget(attachId);
        throw error;
      }
      // Released while the core was answering (window closed, or the terminal ended).
      if (attachments.get(attachId) !== attachment) {
        attachment.stream.close();
        throw new Error("terminal attachment ended");
      }
      return attachId;
    },

    /** The window took `count` output events; their credit goes back to the core. */
    acknowledge(attachId: number, count: number): boolean {
      const attachment = attachments.get(attachId);
      if (!attachment) return false;
      for (const credit of attachment.unacknowledged.splice(0, count)) credit?.();
      return true;
    },

    /** False when the attachment is gone, so the caller can stop typing into nothing. */
    input(attachId: number, data: string, binary: boolean): boolean {
      const stream = attachments.get(attachId)?.stream;
      stream?.write(Buffer.from(data, binary ? "latin1" : "utf8"));
      return stream != null;
    },

    focus(attachId: number, focused: boolean): boolean {
      const stream = attachments.get(attachId)?.stream;
      stream?.focus(focused);
      return stream != null;
    },

    facts(attachId: number, display: HcDisplayFacts): boolean {
      const stream = attachments.get(attachId)?.stream;
      stream?.facts(display);
      return stream != null;
    },

    resize(attachId: number, size: { cols: number; rows: number }): boolean {
      const stream = attachments.get(attachId)?.stream;
      stream?.resize(size.cols, size.rows);
      return stream != null;
    },

    detach(attachId: number): void {
      release(attachId);
    },

    /**
     * Releases every attachment without telling the window: it is closing,
     * reloading or gone, and can no longer detach for itself.
     */
    detachAll(): void {
      releaseEpoch += 1;
      for (const attachId of [...attachments.keys()]) release(attachId);
    },

    /** The connection is gone: every attachment has ended, and the window is told. */
    connectionLost(): void {
      for (const attachId of [...attachments.keys()]) {
        if (forget(attachId)) sink.closed(attachId);
      }
    },

    /** The host is shutting down: forget every attachment; the caller closes the connection. */
    drop(): void {
      releaseEpoch += 1;
      for (const attachId of [...attachments.keys()]) forget(attachId);
    },
  };
}

export type HcSessions = ReturnType<typeof createHcSessions>;
