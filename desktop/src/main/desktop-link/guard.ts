// What a Matrix computer may ask of this device's private herdr-core over the
// desktop link (spec 2716). The guard terminates the protocol on both sides and
// denies by default. It owns the core's handshake: it sends the one fixed
// `hello` and writes nothing else until the core confirms framed mode at
// generation 1, and answers the computer's `hello` itself. Every frame from the
// computer is parsed and rebuilt: on channel 0 only the four calls the Herdr
// client makes, each through a strict schema, under call ids the guard owns; on
// other channels only data for attaches the guard saw the core open. The owner's
// consent (D2) decides starts and every attach or kill of a terminal the link did
// not start, approved as one instance (`address@created_ms`). Answers go back
// rebuilt, carrying only what the computer needs.
import { createHmac, randomBytes } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import * as nodePath from "node:path";
import { z } from "zod/v4";
import { DESKTOP_LINK_METHODS } from "@matrix-os/contracts/desktop-link";
import { encodeCredit, encodeFrame, encodeResize, HC_FRAME, HC_MAX_PAYLOAD, HcFrameDecoder } from "@matrix-os/herdr-core-client/protocol";
import { safeTerminalTitle, TERMINAL_TITLE_LABEL } from "@matrix-os/herdr-core-client/sessions";
import { describeRun, renderVisible, type DesktopLinkConsent } from "./consent";

const MAX_HELLO_BYTES = 64 * 1024;
const MAX_REQUEST_BYTES = 256 * 1024;
/** Calls awaiting the core's answer, the computer's and the guard's own; more are refused. */
const MAX_IN_FLIGHT = 256;
/** Bytes held for the core while its handshake is still open; more end the stream. */
const MAX_HELD_BYTES = 1024 * 1024;
/** Initial output held while a routed attach's machine identity is checked. */
const MAX_UNVERIFIED_BYTES = 1024 * 1024;
/** Attach channels open at once on one stream; the core's own cap is lower. */
const MAX_CHANNELS = 256;
/** How long the guard waits for the core to answer a question of its own. */
const INTERNAL_CALL_MS = 10_000;
/** How long a forwarded call may wait for the core's answer before it is forgotten (the computer gave up at 90 s). */
const FORWARDED_CALL_MS = 120_000;
/** Channels the core closed whose late frames from the computer are dropped quietly; oldest forgotten first. */
const MAX_CLOSING = 256;
/** A terminal size the computer may set, as for attach and run. */
const MAX_CELLS = 1000;
/** On Windows, cmd.exe reads these in a .bat or .cmd file's arguments as its own. */
const CMD_META = /["&|<>^%!()\r\n]/;
/** Calls being decided at once (checks, the core's record, the owner's answer); more are refused before any work starts. */
const MAX_DECIDING = 16;
/** Attach calls forgotten after their deadline: a late answer's viewer is closed in the core. */
const MAX_ABANDONED = 256;

/**
 * Whether a Windows program and its arguments run as shown. Refused for every
 * program: a quote, a stream suffix (`:`), a trailing dot or space (Windows drops
 * those, so `x.bat.` runs x.bat) and a drive-relative path (`C:x.exe`, resolved
 * against a folder the owner is not shown). For a batch file, which cmd.exe
 * reads again, also any of cmd.exe's own characters in its name or arguments.
 */
function plainOnWindows(argv: readonly string[]): boolean {
  const command = argv[0]!;
  if (command.includes('"') || /[. ]$/.test(command) || command.slice(2).includes(":") || /^[A-Za-z]:(?![\\/])/.test(command)) return false;
  return !/\.(bat|cmd)$/i.test(command) || (!CMD_META.test(command) && !argv.slice(1).some((arg) => CMD_META.test(arg)));
}
/** The only protocol generation this guard speaks. */
const GENERATION = 1;
const GUARD_HELLO_ID = 1;
/** The one handshake the core ever gets on a desktop-link stream, exactly what the Herdr client sends. */
const GUARD_HELLO = Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", id: GUARD_HELLO_ID, method: "hello", params: { framed: true } })}\n`);
export const DESKTOP_LINK_FROM_LABEL = "matrix.from";
const WHERE_LABEL = "where";
const MAX_SHOWN_TITLE_CHARS = 120;
const ALLOWED_METHODS: ReadonlySet<string> = new Set(DESKTOP_LINK_METHODS);
/** Frame kinds the computer may send on an open channel: typing, credit, size and close. */
const CHANNEL_KINDS: ReadonlySet<number> = new Set([HC_FRAME.DATA, HC_FRAME.CREDIT, HC_FRAME.RESIZE, HC_FRAME.CLOSE]);

/** A terminal the owner's consent can name: herdr-core's own address on this device, never a name or label. */
const TerminalAddress = z.string().regex(/^t[0-9]{1,9}[a-z]{0,2}$/);
const EnrolledAddress = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,31}\/t[0-9]{1,6}[a-z]{0,2}$/);
const CallId = z.union([z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), z.string().min(1).max(64)]);
const Cells = z.number().int().min(1).max(1000);
// Terminal and locale settings only, with plain values: nothing a program could read as more.
const Env = z.record(z.string().regex(/^(TERM|COLORTERM|LANG|LC_[A-Z_]+)$/), z.string().regex(/^[A-Za-z0-9._@:+-]{0,64}$/))
  .refine((env) => Object.keys(env).length <= 16);

// What the computer's Herdr client sends (herdr-core-client session host), and nothing more.
const RunParams = z.strictObject({
  argv: z.array(z.string().max(4 * 1024)).min(1).max(64).optional(),
  line: z.string().min(1).max(16 * 1024).optional(),
  cwd: z.string().min(1).max(4 * 1024).optional(),
  // A name never looks like an address, so no dialog can confuse the two.
  name: z.string().regex(/^[a-z0-9_.-]{1,32}$/).refine((name) => !/^t[0-9]/.test(name)).optional(),
  size: z.strictObject({ cols: Cells, rows: Cells }).optional(),
  env: Env.optional(),
  no_parent: z.literal(true).optional(),
  no_notify: z.literal(true).optional(),
  wait: z.literal(false).optional(),
}).refine((params) => !(params.argv && params.line), { message: "one program" });
const ListParams = z.strictObject({});
const EnrolledListParams = z.strictObject({ enrolled: z.literal(true) });
const AttachParams = z.strictObject({
  terminal: z.union([TerminalAddress, EnrolledAddress]),
  cols: Cells,
  rows: Cells,
  history: z.number().int().min(0).max(100_000).optional(),
  observe: z.boolean().optional(),
  selection_revision: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  remote_scope: z.string().regex(/^[a-f0-9]{64}$/).optional(),
});
const KillParams = z.strictObject({ terminal: TerminalAddress });
/** The computer's handshake: exactly what its Herdr client sends. */
const HelloParams = z.strictObject({ framed: z.literal(true) });
const Request = z.strictObject({
  jsonrpc: z.literal("2.0").optional(),
  id: CallId,
  method: z.string().max(64),
  params: z.unknown().optional(),
});

// What the guard reads from the core's answers.
const CoreTerminal = z.object({
  address: z.string().max(128),
  state: z.string().max(32),
  // Required by herdr-core; without it a terminal cannot be told from a later one at its address.
  created_ms: z.number().int().optional().catch(undefined),
  pid: z.int().positive().optional().catch(undefined),
  cwd: z.string().max(4 * 1024).optional().catch(undefined),
  title: z.string().nullable().optional().catch(null),
  name: z.string().nullable().optional().catch(null),
  labels: z.record(z.string(), z.string()).nullable().optional().catch(null),
  argv: z.array(z.string()).max(4096).nullable().optional().catch(null),
  status: z.object({ state: z.string().max(32), msg: z.string().max(2000).optional().catch(undefined) }).nullable().optional().catch(null),
});
type CoreTerminal = z.infer<typeof CoreTerminal>;
const CoreList = z.object({ terminals: z.array(z.unknown()).max(10_000) });
const EnrolledMachines = z.object({ machines: z.array(z.unknown()).max(256) });
const EnrolledMachine = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,31}$/), id: z.string().regex(/^[a-f0-9]{32}$/), state: z.literal("connected"),
});
const CoreTemplates = z.object({ templates: z.array(z.looseObject({ name: z.string().max(256) })).max(1024) });
const CoreReply = z.object({
  id: z.union([z.number(), z.string(), z.null()]),
  result: z.unknown().optional(),
  error: z.looseObject({ code: z.number().optional(), data: z.unknown().optional() }).optional(),
});
type CoreReply = z.infer<typeof CoreReply>;
const CoreHello = z.object({
  id: z.literal(GUARD_HELLO_ID),
  result: z.looseObject({
    version: z.string().max(32),
    generation: z.literal(GENERATION),
    framed: z.literal(true),
    features: z.array(z.string().max(64)).max(64),
    methods: z.array(z.string().max(64)).max(256).optional(),
  }),
});
type CoreHello = z.infer<typeof CoreHello>["result"];

/** The stream must end: the computer (or the core) broke the protocol. */
export class DesktopLinkGuardError extends Error {
  constructor(readonly reason: "handshake" | "malformed" | "too_large" | "channel") {
    super("desktop link stream refused");
    this.name = "DesktopLinkGuardError";
  }
}

export interface DesktopLinkGuardResult {
  /**
   * What this push handed to the core, for logs and tests: the guard writes it
   * itself (held until the core's handshake confirms framed mode). Never write it again.
   */
  forwarded: Buffer[];
  /** Answers for the computer: the handshake, and refused calls. */
  toComputer: Buffer[];
  /**
   * Calls waiting for the owner, or for the core's own record of a terminal,
   * decided off the stream's queue so everything else keeps moving.
   */
  deferred?: Array<Promise<Decided>>;
}
type Decided = Omit<DesktopLinkGuardResult, "deferred">;

export interface DesktopLinkGuardOptions {
  /** Per admitted device link; core streams may idle out without invalidating the selected terminal. */
  selectionKey?: Buffer;
  /** The desktop user's home; terminals start here or in a folder under it. */
  home: string;
  /** The computer's name, written on every terminal it starts. */
  computerName: string;
  /** Replaced in tests. Resolves symlinks; rejects when the folder does not exist. */
  resolveFolder?: (path: string) => Promise<string>;
  /** Path rules of this desktop's OS (`path.win32` on Windows); replaced in tests. */
  pathApi?: Pick<typeof nodePath, "isAbsolute" | "join" | "relative">;
  /** How a start's argv reads on this desktop (Windows joins it into one command line). */
  platform?: NodeJS.Platform;
  /** The owner's consent for this link (spec 2716, D2). Without one nothing needs approval (tests only). */
  consent?: DesktopLinkConsent;
}

type Pending =
  | { kind: "list" | "run" | "attach" | "kill"; callerId: string | number; timer: ReturnType<typeof setTimeout>; expect?: string | null; terminal?: string; machineId?: string }
  | { kind: "internal"; settle(reply: CoreReply | null): void };

function frame(payload: unknown): Buffer {
  return encodeFrame(0, HC_FRAME.DATA, Buffer.from(JSON.stringify(payload)));
}

function denial(id: string | number): Buffer {
  return frame({ jsonrpc: "2.0", id, error: { code: -32601, message: "not allowed from this computer", data: { kind: "denied" } } });
}

function failure(id: string | number, kind = "failed", code = -32000): Buffer {
  return frame({ jsonrpc: "2.0", id, error: { code, message: "terminal call failed", data: { kind } } });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function baseName(command: string): string {
  return command.slice(Math.max(command.lastIndexOf("/"), command.lastIndexOf("\\")) + 1);
}

/** A template a name could reach: compared by its last path part, without case or `.md`. */
function templateKey(name: string): string {
  return baseName(name).toLowerCase().replace(/\.md$/, "");
}

/** A terminal as the computer may see it: address, state, title and status. */
function shown(terminal: CoreTerminal) {
  const status = terminal.status;
  return {
    address: terminal.address,
    state: terminal.state,
    title: safeTerminalTitle(
      terminal.labels?.[TERMINAL_TITLE_LABEL], terminal.title, terminal.name, terminal.labels?.[WHERE_LABEL],
      terminal.argv?.[0] ? baseName(terminal.argv[0]) : undefined,
    ),
    ...(status ? { status: { state: status.state, ...(status.msg ? { msg: status.msg.slice(0, 200) } : {}) } } : {}),
  };
}

export function createDesktopLinkGuard(options: DesktopLinkGuardOptions) {
  const selectionKey = options.selectionKey ?? randomBytes(32);
  const enrolledStreamId = randomBytes(16).toString("hex");
  function selectionRevision(terminal: CoreTerminal) {
    if (terminal.created_ms === undefined) return undefined;
    return createHmac("sha256", selectionKey).update(JSON.stringify([terminal.address, terminal.created_ms])).digest("hex");
  }
  function enrolledRevision(terminal: CoreTerminal, machineId: string) {
    if (terminal.state !== "live" || terminal.pid === undefined || terminal.created_ms === undefined || !terminal.cwd) return undefined;
    return createHmac("sha256", selectionKey).update(JSON.stringify([
      "enrolled", machineId, terminal.address, terminal.pid, terminal.created_ms, terminal.cwd,
    ])).digest("hex");
  }
  const pathApi = options.pathApi ?? nodePath;
  const resolveFolder = options.resolveFolder ?? (async (path: string) => {
    const resolved = await realpath(path);
    if (!(await stat(resolved)).isDirectory()) throw new Error("not a folder");
    return resolved;
  });
  // A control frame over the request cap is refused as soon as its header arrives.
  const decoder = new HcFrameDecoder((channel) => (channel === 0 ? MAX_REQUEST_BYTES : HC_MAX_PAYLOAD));
  const coreDecoder = new HcFrameDecoder();
  // The stream ended: approvals on screen close, nothing more is written.
  const ended = new AbortController();
  // The computer's side: its hello (answered here), then frames.
  let greeted = false;
  let pending: Buffer = Buffer.alloc(0);
  let computerHelloId: string | number | null = null;
  let helloAnswered = false;
  // The core's side: the guard's own handshake, then frames.
  let writeCore: ((bytes: Buffer) => void) | null = null;
  let deliver: ((frames: Buffer[]) => void) | null = null;
  let coreHello: CoreHello | null = null;
  let corePending: Buffer = Buffer.alloc(0);
  let held: Buffer[] = [];
  let heldBytes = 0;
  let home: Promise<string> | null = null;
  // Every call reaches the core under a guard-owned id; the caller's own id goes back on the answer.
  const inFlight = new Map<number, Pending>();
  let nextId = GUARD_HELLO_ID + 1;
  // Channels the core opened for attaches this guard forwarded: the only ones data may use.
  const channels = new Set<number>();
  const unverified = new Map<number, { frames: Buffer[]; bytes: number; callerId: string | number }>();
  let unverifiedBytes = 0;
  // Channels the core closed: a credit or keystroke the computer sent before it heard is dropped.
  const closing = new Set<number>();
  const abandoned = new Set<number>();
  let deciding = 0;

  function closed(channel: number): void {
    channels.delete(channel);
    closing.add(channel);
    if (closing.size > MAX_CLOSING) closing.delete(closing.values().next().value!);
  }

  /** Every byte for the core goes through here: held until the core's handshake confirmed framed mode. */
  function toCore(bytes: Buffer): void {
    if (ended.signal.aborted) return;
    if (coreHello && writeCore) { writeCore(bytes); return; }
    heldBytes += bytes.length;
    if (heldBytes > MAX_HELD_BYTES) throw new DesktopLinkGuardError("too_large");
    held.push(bytes);
  }

  /** The computer's handshake answer: the core's, offering only the calls the guard lets through. */
  function helloAnswer(): Buffer | null {
    if (!coreHello || computerHelloId === null || helloAnswered) return null;
    helloAnswered = true;
    const { version, generation, features, methods } = coreHello;
    return Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", id: computerHelloId, result: {
      version, generation, framed: true, features: [...features],
      methods: (methods ?? []).filter((method) => ALLOWED_METHODS.has(method)),
    } })}\n`);
  }

  /** A folder the computer names, or home when it names none: always inside home, after symlinks. */
  async function folderUnderHome(cwd: string | undefined): Promise<string | null> {
    home ??= resolveFolder(options.home);
    const root = await home;
    if (cwd === undefined) return root;
    if (cwd.includes("\0")) return null;
    let resolved: string;
    try {
      resolved = await resolveFolder(pathApi.isAbsolute(cwd) ? cwd : pathApi.join(root, cwd));
    } catch (error: unknown) {
      if (error instanceof Error) return null;
      throw error;
    }
    // Inside home: home itself, or a path below it (never `..`, never another drive).
    const inside = pathApi.relative(root, resolved);
    return inside === "" || (!inside.startsWith("..") && !pathApi.isAbsolute(inside)) ? resolved : null;
  }

  function track(entry: Pending): number | null {
    if (inFlight.size >= MAX_IN_FLIGHT) return null;
    const id = nextId++;
    inFlight.set(id, entry);
    return id;
  }

  /** Asks the core something for the guard's own decision; the answer never reaches the computer. Null: no answer. */
  function ask(method: "terminal.list" | "templates.list" | "machine.list"): Promise<CoreReply | null> {
    if (!writeCore) return Promise.resolve(null);
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const id = track({ kind: "internal", settle: (reply) => { clearTimeout(timer); resolve(reply); } });
      if (id === null) { resolve(null); return; }
      timer = setTimeout(() => { inFlight.delete(id); resolve(null); }, INTERNAL_CALL_MS);
      timer.unref?.();
      toCore(frame({ jsonrpc: "2.0", id, method, params: {} }));
    });
  }

  /** The core's current record of one live terminal on this device, or null. */
  async function current(address: string): Promise<CoreTerminal | null> {
    const terminals = CoreList.safeParse((await ask("terminal.list"))?.result);
    if (!terminals.success) return null;
    for (const entry of terminals.data.terminals) {
      const terminal = CoreTerminal.safeParse(entry);
      if (terminal.success && terminal.data.address === address && terminal.data.state === "live") return terminal.data;
    }
    return null;
  }

  function connectedRoutes(machines: CoreReply | null) {
    const routes = EnrolledMachines.safeParse(machines?.result);
    const connected = new Map<string, string>();
    if (!routes.success) return connected;
    const duplicates = new Set<string>();
    for (const raw of routes.data.machines) {
      const route = EnrolledMachine.safeParse(raw);
      if (!route.success) continue;
      if (connected.has(route.data.name)) duplicates.add(route.data.name);
      connected.set(route.data.name, route.data.id);
    }
    for (const alias of duplicates) connected.delete(alias);
    return connected;
  }

  async function getEnrolledTargets() {
    const [terminals, machines] = await Promise.all([ask("terminal.list"), ask("machine.list")]);
    const rows = CoreList.safeParse(terminals?.result);
    if (!rows.success) return [];
    const connected = connectedRoutes(machines);
    return rows.data.terminals.flatMap((raw) => {
      const parsed = CoreTerminal.safeParse(raw);
      if (!parsed.success || !EnrolledAddress.safeParse(parsed.data.address).success) return [];
      const terminal = parsed.data;
      const machine = terminal.address.slice(0, terminal.address.indexOf("/"));
      const machineId = connected.get(machine);
      if (!machineId) return [];
      const revision = enrolledRevision(terminal, machineId);
      return revision ? [{ terminal, machine, machineId, revision }] : [];
    });
  }

  async function enrolledList(callerId: string | number): Promise<Decided> {
    if (!options.consent) return refused(callerId);
    const terminals = (await getEnrolledTargets()).slice(0, 500).map(({ terminal, revision }) => ({
      ...shown(terminal), selection_revision: revision,
    }));
    return { forwarded: [], toComputer: [frame({ jsonrpc: "2.0", id: callerId, result: { terminals } })] };
  }

  /**
   * Whether `argv[0]` is a plain program. herdr-core starts a template's own
   * command when argv[0] names one, so a start that could is refused: the owner
   * is only ever shown what runs. Names are compared without case, path or
   * `.md`; a relative path is refused outright. A core that cannot be asked
   * refuses too; a core without templates (it answers with an error) has none.
   */
  async function plainProgram(argv: readonly string[]): Promise<boolean> {
    const command = argv[0]!;
    if (!pathApi.isAbsolute(command) && (command.includes("/") || command.includes("\\"))) return false;
    const reply = await ask("templates.list");
    if (!reply) return false;
    if (reply.error) return true;
    const templates = CoreTemplates.safeParse(reply.result);
    const wanted = templateKey(command);
    return templates.success && !templates.data.templates.some((entry) => templateKey(entry.name) === wanted);
  }

  function forward(kind: "list" | "run" | "attach" | "kill", callerId: string | number, params: Record<string, unknown>, expect?: string | null, machineId?: string): Decided {
    if (ended.signal.aborted) return { forwarded: [], toComputer: [] };
    const timer = setTimeout(() => {
      if (id === null || !inFlight.delete(id) || kind !== "attach") return;
      abandoned.add(id);
      if (abandoned.size > MAX_ABANDONED) abandoned.delete(abandoned.values().next().value!);
    }, FORWARDED_CALL_MS);
    timer.unref?.();
    const terminal = typeof params.terminal === "string" ? params.terminal : undefined;
    const id = track({ kind, callerId, timer, ...(expect === undefined ? {} : { expect }), ...(terminal ? { terminal } : {}), ...(machineId ? { machineId } : {}) });
    if (id === null) { clearTimeout(timer); return { forwarded: [], toComputer: [denial(callerId)] }; }
    const bytes = frame({ jsonrpc: "2.0", id, method: `terminal.${kind}`, params });
    toCore(bytes);
    return { forwarded: [bytes], toComputer: [] };
  }

  const refused = (callerId: string | number): Decided => ({ forwarded: [], toComputer: [denial(callerId)] });

  async function run(callerId: string | number, params: z.infer<typeof RunParams>): Promise<Decided> {
    const { argv, line, name, size, env } = params;
    const cwd = await folderUnderHome(params.cwd);
    if (cwd === null) return refused(callerId);
    if (options.consent) {
      const command = describeRun({ argv, line }, options.platform);
      const folder = renderVisible(cwd);
      if (command === null || folder === null) return refused(callerId);
      if (argv && !(await plainProgram(argv))) return refused(callerId);
      // A batch file's arguments are read again by cmd.exe, which would run more than is shown.
      if (options.platform === "win32" && argv && !plainOnWindows(argv)) return refused(callerId);
      if (!(await options.consent.run({ command, cwd: folder }, ended.signal))) return refused(callerId);
    }
    // Rebuilt from what was checked. Fixed: never replaced by a shell when it ends, never
    // tied to or reporting into another terminal, and labelled with the computer's name.
    return forward("run", callerId, {
      ...(argv ? { argv: [...argv] } : {}), ...(line ? { line } : {}), cwd, ...(name ? { name } : {}),
      ...(size ? { size: { cols: size.cols, rows: size.rows } } : {}), ...(env ? { env: { ...env } } : {}),
      labels: { [DESKTOP_LINK_FROM_LABEL]: options.computerName },
      keep: false, no_parent: true, no_notify: true, wait: false,
    });
  }

  const instanceOf = (terminal: CoreTerminal) => (terminal.created_ms === undefined ? null : `${terminal.address}@${terminal.created_ms}`);

  async function openEnrolled(callerId: string | number, params: z.infer<typeof AttachParams>): Promise<Decided> {
    const { selection_revision: selected, remote_scope: scope, ...coreParams } = params;
    if (!selected || !scope || !options.consent) return refused(callerId);
    const currentTarget = async () => {
      const matches = (await getEnrolledTargets()).filter(row => row.terminal.address === params.terminal);
      return matches.length === 1 && matches[0]!.revision === selected ? matches[0] : undefined;
    };
    const target = await currentTarget();
    if (!target) return refused(callerId);
    const { terminal, machine } = target;
    const cwd = terminal.cwd && renderVisible(terminal.cwd);
    if (!cwd) return refused(callerId);
    const allowed = await options.consent.remoteTerminal(enrolledStreamId + ":" + scope + ":" + selected, {
      machine, terminal: terminal.address,
      title: renderVisible(shown(terminal).title, MAX_SHOWN_TITLE_CHARS) ?? "(a title too long to show)",
      program: (terminal.argv?.length ? describeRun({ argv: terminal.argv }, options.platform) : null) ?? "a program it does not name",
      cwd,
    }, ended.signal);
    if (!allowed || !await currentTarget()) return refused(callerId);
    return forward("attach", callerId, coreParams, selected, target.machineId);
  }

  async function onTerminal(kind: "attach" | "kill", callerId: string | number, params: Record<string, unknown> & { terminal: string }): Promise<Decided> {
    let expect: string | null = null;
    const { selection_revision: selected, ...coreParams } = params;
    if (options.consent || selected !== undefined) {
      const terminal = await current(params.terminal);
      if (!terminal || (selected !== undefined && selectionRevision(terminal) !== selected)) return refused(callerId);
      const instance = instanceOf(terminal);
      expect = instance;
      if (options.consent && (instance === null || !options.consent.covers(instance))) {
        const allowed = await options.consent.terminal({
          instance, action: kind === "kill" ? "end" : "open", terminal: terminal.address,
          title: renderVisible(shown(terminal).title, MAX_SHOWN_TITLE_CHARS) ?? "(a title too long to show)",
          program: (terminal.argv?.length ? describeRun({ argv: terminal.argv }, options.platform) : null) ?? "a program it does not name",
          cwd: (terminal.cwd ? renderVisible(terminal.cwd) : null) ?? "a folder it does not name",
        }, ended.signal);
        if (!allowed) return refused(callerId);
        // The owner took time to answer: it must still be the same terminal.
        const now = await current(params.terminal);
        if (!now || instanceOf(now) !== instance) return refused(callerId);
      }
    }
    return forward(kind, callerId, coreParams, expect);
  }

  /** The computer's first, unframed line: exactly `hello` with `framed: true`. Never forwarded. */
  function greet(line: Buffer): void {
    let raw: unknown;
    try { raw = JSON.parse(line.toString("utf8")); } catch (error: unknown) {
      if (error instanceof SyntaxError) throw new DesktopLinkGuardError("handshake");
      throw error;
    }
    const request = Request.safeParse(raw);
    if (!request.success || request.data.method !== "hello" || !HelloParams.safeParse(request.data.params).success) {
      throw new DesktopLinkGuardError("handshake");
    }
    computerHelloId = request.data.id;
  }

  /** The core's answer to the guard's handshake: framed, generation 1, or the stream ends. */
  function confirmCore(line: Buffer): void {
    let raw: unknown;
    try { raw = JSON.parse(line.toString("utf8")); } catch (error: unknown) {
      if (error instanceof SyntaxError) throw new DesktopLinkGuardError("handshake");
      throw error;
    }
    const hello = CoreHello.safeParse(raw);
    if (!hello.success) throw new DesktopLinkGuardError("handshake");
    coreHello = hello.data.result;
    const release = held;
    held = [];
    heldBytes = 0;
    for (const bytes of release) writeCore!(bytes);
  }

  function releaseUnverified(channel: number) {
    const pending = unverified.get(channel);
    if (!pending) return undefined;
    unverified.delete(channel);
    unverifiedBytes -= pending.bytes;
    return pending;
  }

  function rejectUnverified(channel: number, coreClosed = false) {
    const pending = releaseUnverified(channel);
    if (!pending) return undefined;
    if (!coreClosed) toCore(encodeFrame(channel, HC_FRAME.CLOSE, Buffer.alloc(0)));
    return failure(pending.callerId);
  }

  function verifyEnrolledAttach(channel: number, callerId: string | number, terminal: string, machineId: string, response: Buffer) {
    // The reply identifies the PTY but doesn't identify the machine behind its alias.
    // Hold initial output and deny input until a fresh route lookup confirms that machine.
    const pending = { frames: [] as Buffer[], bytes: 0, callerId };
    unverified.set(channel, pending);
    const alias = terminal.slice(0, terminal.indexOf("/"));
    void ask("machine.list").then((reply) => {
      if (ended.signal.aborted || unverified.get(channel) !== pending) return;
      if (connectedRoutes(reply).get(alias) !== machineId || !deliver) {
        const refused = rejectUnverified(channel);
        if (refused) deliver?.([refused]);
        return;
      }
      releaseUnverified(channel);
      channels.add(channel);
      closing.delete(channel);
      deliver([response, ...pending.frames]);
    });
  }

  /** The core's answer to one of the computer's calls, carrying only what the computer needs. */
  function answer(entry: Extract<Pending, { callerId: string | number }>, reply: CoreReply): Buffer | undefined {
    const id = entry.callerId;
    if (reply.error) {
      const data = reply.error.data;
      const kind = isRecord(data) && typeof data.kind === "string" && /^[a-z_]{1,32}$/.test(data.kind) ? data.kind : "failed";
      return failure(id, kind, typeof reply.error.code === "number" ? reply.error.code : -32000);
    }
    const result = reply.result;
    switch (entry.kind) {
      case "list": {
        const listed = CoreList.safeParse(result);
        const terminals = (listed.success ? listed.data.terminals : []).flatMap((item) => {
          const terminal = CoreTerminal.safeParse(item);
          // Only this device's own terminals, never one on a machine its core reaches.
          return terminal.success && TerminalAddress.safeParse(terminal.data.address).success ? [{ ...shown(terminal.data), selection_revision: selectionRevision(terminal.data) }] : [];
        });
        return frame({ jsonrpc: "2.0", id, result: { terminals, hidden_finished: 0, machines: [] } });
      }
      case "run": {
        const terminal = CoreTerminal.safeParse(result);
        if (!terminal.success || !TerminalAddress.safeParse(terminal.data.address).success) return failure(id);
        // Started under the owner's approval: this exact terminal is covered from now on.
        const instance = instanceOf(terminal.data);
        if (instance !== null) options.consent?.started(instance);
        return frame({ jsonrpc: "2.0", id, result: { address: terminal.data.address, state: terminal.data.state } });
      }
      case "attach": {
        const attached = isRecord(result) ? result : {};
        const channel = attached.channel;
        if (typeof channel !== "number" || !Number.isInteger(channel) || channel < 1 || channel > 0xffff_ffff) return failure(id);
        // The terminal the core attached must be the one the owner approved, when one was.
        const record = CoreTerminal.safeParse(attached.terminal);
        const wrongTerminal = entry.machineId
          ? !record.success || enrolledRevision(record.data, entry.machineId) !== entry.expect
          : entry.expect !== undefined && entry.expect !== null
          ? !record.success || instanceOf(record.data) !== entry.expect
          // Under consent the attached terminal must be named; without (tests only) it is compared when given.
          : options.consent ? !record.success || record.data.address !== entry.terminal : record.success && record.data.address !== entry.terminal;
        if (wrongTerminal || channels.has(channel) || unverified.has(channel) || channels.size + unverified.size >= MAX_CHANNELS) {
          // Turned down after the core opened a viewer: close it there.
          const refused = rejectUnverified(channel);
          if (refused) deliver?.([refused]);
          else if (!channels.has(channel)) toCore(encodeFrame(channel, HC_FRAME.CLOSE, Buffer.alloc(0)));
          return failure(id);
        }
        const response = frame({ jsonrpc: "2.0", id, result: {
          channel,
          resize_notifications: attached.resize_notifications === true,
          automatic_input: attached.automatic_input === true,
        } });
        if (entry.machineId && record.success) {
          verifyEnrolledAttach(channel, id, record.data.address, entry.machineId, response);
          return undefined;
        }
        channels.add(channel);
        closing.delete(channel);
        return response;
      }
      case "kill": {
        const terminal = CoreTerminal.safeParse(result);
        return frame({ jsonrpc: "2.0", id, result: terminal.success ? { address: terminal.data.address, state: terminal.data.state } : {} });
      }
    }
  }

  /** A stream frame rebuilt from its parsed fields: credit as a count, a size within bounds, a bare close. */
  function rebuildStream(channel: number, kind: number, payload: Buffer): Buffer {
    switch (kind) {
      case HC_FRAME.CREDIT:
        if (payload.length !== 4) throw new DesktopLinkGuardError("malformed");
        return encodeCredit(channel, payload.readUInt32LE(0));
      case HC_FRAME.RESIZE: {
        if (payload.length !== 4) throw new DesktopLinkGuardError("malformed");
        const cols = payload.readUInt16LE(0);
        const rows = payload.readUInt16LE(2);
        if (cols < 1 || rows < 1 || cols > MAX_CELLS || rows > MAX_CELLS) throw new DesktopLinkGuardError("malformed");
        return encodeResize(channel, cols, rows);
      }
      case HC_FRAME.CLOSE:
        return encodeFrame(channel, HC_FRAME.CLOSE, Buffer.alloc(0));
      default:
        return encodeFrame(channel, HC_FRAME.DATA, payload);
    }
  }

  return {
    /** The stream ended: approvals on screen close (a late Allow is a no), and nothing more reaches the core. */
    close(): void {
      ended.abort();
      for (const entry of inFlight.values()) if (entry.kind === "internal") entry.settle(null); else clearTimeout(entry.timer);
      inFlight.clear();
      unverified.clear();
      unverifiedBytes = 0;
      held = [];
    },

    /**
     * The guard's own connection to the core is open: it sends the fixed
     * handshake now, and every later byte for the core goes through `write`.
     */
    connect(write: (bytes: Buffer) => void, deliverVerified?: (frames: Buffer[]) => void): void {
      if (writeCore) return;
      writeCore = write;
      deliver = deliverVerified ?? null;
      write(GUARD_HELLO);
    },

    /**
     * Takes the next bytes from the computer. Call again only after the
     * previous call settled, so order is kept. Throws DesktopLinkGuardError when
     * the stream must end.
     */
    async push(chunk: Buffer): Promise<DesktopLinkGuardResult> {
      const result: DesktopLinkGuardResult = { forwarded: [], toComputer: [] };
      const add = (decided: Decided) => { result.forwarded.push(...decided.forwarded); result.toComputer.push(...decided.toComputer); };
      // A slot is taken before any folder check or question starts, and given back when the call is decided.
      const defer = (id: string | number, decide: () => Promise<Decided>) => {
        if (deciding >= MAX_DECIDING) { add(refused(id)); return; }
        deciding += 1;
        (result.deferred ??= []).push(decide().finally(() => { deciding -= 1; }));
      };
      let bytes = chunk;
      if (!greeted) {
        pending = Buffer.concat([pending, bytes]);
        const newline = pending.indexOf(10);
        if (newline < 0) {
          if (pending.length > MAX_HELLO_BYTES) throw new DesktopLinkGuardError("too_large");
          return result;
        }
        if (newline > MAX_HELLO_BYTES) throw new DesktopLinkGuardError("too_large");
        greet(pending.subarray(0, newline));
        greeted = true;
        const answered = helloAnswer();
        if (answered) result.toComputer.push(answered);
        bytes = pending.subarray(newline + 1);
        pending = Buffer.alloc(0);
        if (bytes.length === 0) return result;
      }
      let frames;
      try { frames = decoder.push(bytes); } catch (error: unknown) {
        if (error instanceof Error) throw new DesktopLinkGuardError("too_large");
        throw error;
      }
      for (const incoming of frames) {
        if (incoming.channel !== 0) {
          // A late credit or keystroke for a channel the core just closed: dropped.
          if (closing.has(incoming.channel)) { if (incoming.kind === HC_FRAME.CLOSE) closing.delete(incoming.channel); continue; }
          // Only channels the core opened for an attach the guard forwarded, and only stream kinds.
          if (!channels.has(incoming.channel) || !CHANNEL_KINDS.has(incoming.kind)) throw new DesktopLinkGuardError("channel");
          const rebuilt = rebuildStream(incoming.channel, incoming.kind, incoming.payload);
          toCore(rebuilt);
          result.forwarded.push(rebuilt);
          if (incoming.kind === HC_FRAME.CLOSE) closed(incoming.channel);
          continue;
        }
        if (incoming.kind !== HC_FRAME.DATA) continue;
        if (incoming.payload.length > MAX_REQUEST_BYTES) throw new DesktopLinkGuardError("too_large");
        let raw: unknown;
        try { raw = JSON.parse(incoming.payload.toString("utf8")); } catch (error: unknown) {
          if (error instanceof SyntaxError) throw new DesktopLinkGuardError("malformed");
          throw error;
        }
        const request = Request.safeParse(raw);
        if (!request.success) {
          // Notifications, replies, batches and anything shaped otherwise: answered when they name an id, never forwarded.
          const id = CallId.safeParse(isRecord(raw) ? raw.id : undefined);
          if (id.success) result.toComputer.push(denial(id.data));
          continue;
        }
        const { id, method, params } = request.data;
        switch (method) {
          case "terminal.list":
            if (EnrolledListParams.safeParse(params).success) defer(id, () => enrolledList(id));
            else add(ListParams.safeParse(params ?? {}).success ? forward("list", id, {}) : refused(id));
            break;
          case "terminal.run": {
            const checked = RunParams.safeParse(params ?? {});
            if (!checked.success) { add(refused(id)); break; }
            if (options.consent) defer(id, () => run(id, checked.data));
            else add(await run(id, checked.data));
            break;
          }
          case "terminal.attach": {
            const checked = AttachParams.safeParse(params);
            if (!checked.success) { add(refused(id)); break; }
            if (EnrolledAddress.safeParse(checked.data.terminal).success) { defer(id, () => openEnrolled(id, checked.data)); break; }
            if (checked.data.remote_scope !== undefined) { add(refused(id)); break; }
            const { terminal, cols, rows, history, observe, selection_revision } = checked.data;
            const rebuilt = { terminal, cols, rows, ...(selection_revision ? { selection_revision } : {}), ...(history === undefined ? {} : { history }), ...(observe === undefined ? {} : { observe }) };
            if (options.consent) defer(id, () => onTerminal("attach", id, rebuilt));
            else add(await onTerminal("attach", id, rebuilt));
            break;
          }
          case "terminal.kill": {
            const checked = KillParams.safeParse(params);
            if (!checked.success) { add(refused(id)); break; }
            const rebuilt = { terminal: checked.data.terminal };
            if (options.consent) defer(id, () => onTerminal("kill", id, rebuilt));
            else add(await onTerminal("kill", id, rebuilt));
            break;
          }
          default:
            add(refused(id));
        }
      }
      return result;
    },

    /**
     * The core's bytes on their way to the computer, rebuilt: the handshake is
     * the guard's, answers to the guard's own questions stay here, answers to
     * the computer's calls carry only what it needs, and anything else on the
     * control channel is dropped. Bytes on attached channels pass. Throws when
     * the core's handshake or framing breaks, so the stream ends.
     */
    fromCore(chunk: Buffer): Buffer[] {
      const out: Buffer[] = [];
      let bytes = chunk;
      if (!coreHello) {
        corePending = Buffer.concat([corePending, bytes]);
        const newline = corePending.indexOf(10);
        if (newline < 0) {
          if (corePending.length > MAX_HELLO_BYTES) throw new DesktopLinkGuardError("too_large");
          return out;
        }
        if (!writeCore) throw new DesktopLinkGuardError("handshake");
        confirmCore(corePending.subarray(0, newline));
        const answered = helloAnswer();
        if (answered) out.push(answered);
        bytes = corePending.subarray(newline + 1);
        corePending = Buffer.alloc(0);
        if (bytes.length === 0) return out;
      }
      let frames;
      try { frames = coreDecoder.push(bytes); } catch (error: unknown) {
        if (error instanceof Error) throw new DesktopLinkGuardError("malformed");
        throw error;
      }
      for (const incoming of frames) {
        if (incoming.channel !== 0) {
          const pending = unverified.get(incoming.channel);
          if (pending) {
            const coreClosed = incoming.kind === HC_FRAME.CLOSE;
            const bytes = encodeFrame(incoming.channel, incoming.kind, incoming.payload);
            if (coreClosed || unverifiedBytes + bytes.length > MAX_UNVERIFIED_BYTES) {
              const refused = rejectUnverified(incoming.channel, coreClosed);
              if (refused) out.push(refused);
            } else {
              unverifiedBytes += bytes.length;
              pending.bytes += bytes.length;
              pending.frames.push(bytes);
            }
            continue;
          }
          // A channel's bytes, only once its attach answer went to the computer.
          if (!channels.has(incoming.channel)) continue;
          out.push(encodeFrame(incoming.channel, incoming.kind, incoming.payload));
          if (incoming.kind === HC_FRAME.CLOSE) closed(incoming.channel);
          continue;
        }
        if (incoming.kind !== HC_FRAME.DATA) continue;
        let raw: unknown;
        try { raw = JSON.parse(incoming.payload.toString("utf8")); } catch (error: unknown) {
          if (error instanceof SyntaxError) continue;
          throw error;
        }
        const reply = CoreReply.safeParse(raw);
        // The core's own notifications and anything not an answer to a tracked call stay here.
        if (!reply.success || typeof reply.data.id !== "number" || (isRecord(raw) && "method" in raw)) continue;
        if (abandoned.delete(reply.data.id)) {
          // An attach the computer gave up on: close the viewer the core opened for it.
          const late = isRecord(reply.data.result) ? reply.data.result.channel : undefined;
          if (typeof late === "number" && Number.isInteger(late) && late > 0 && late <= 0xffff_ffff && !channels.has(late)) {
            toCore(encodeFrame(late, HC_FRAME.CLOSE, Buffer.alloc(0)));
          }
          continue;
        }
        const entry = inFlight.get(reply.data.id);
        if (!entry) continue;
        inFlight.delete(reply.data.id);
        if (entry.kind === "internal") { entry.settle(reply.data); continue; }
        clearTimeout(entry.timer);
        const response = answer(entry, reply.data);
        if (response) out.push(response);
      }
      return out;
    },
  };
}

export type DesktopLinkGuard = ReturnType<typeof createDesktopLinkGuard>;
