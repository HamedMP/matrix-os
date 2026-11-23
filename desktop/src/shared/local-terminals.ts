// IPC contract for local terminals in the Terminal window (spec 651 FR-008).
// The renderer names terminals and sends keystrokes; it never sees the
// herdr-core socket, its path, or raw JSON-RPC.
import { z } from "zod/v4";

export const LOCAL_TERMINAL_VERSION = "0.1.19";

/** Compares herdr-core versions (`x.y.z`); null when either cannot be read. */
export function compareCoreVersions(left: string, right: string): number | null {
  const parse = (value: string) => /^(\d+)\.(\d+)\.(\d+)$/.exec(value)?.slice(1).map(Number);
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return a[index]! - b[index]!;
  return 0;
}
export const LOCAL_TERMINAL_SESSION_PREFIX = "local:";
// Terminals are not count-capped. This bounds one listing, and matches the
// most the core reports.
export const LOCAL_TERMINAL_LIST_MAX = 1_000;
const MAX_INPUT_CHARS = 65_536;
/** The most output events one acknowledgement may cover; larger batches are split. */
export const LOCAL_TERMINAL_MAX_ACK_COUNT = 4_096;
const BYTE_STRING = /^[\u0000-\u00ff]*$/;
export const LOCAL_TERMINAL_MAX_OUTPUT_CHARS = 262_144;

export const LOCAL_TERMINAL_ID_PATTERN = /^t[0-9]{1,6}[a-z]{0,2}$/;
export const LocalTerminalIdSchema = z.string().regex(LOCAL_TERMINAL_ID_PATTERN);
/**
 * A terminal this core reports, here (`t7`) or on a machine it added
 * (`vps/t7`); machine names follow herdr-core's terminal-name rules.
 */
export const LOCAL_TERMINAL_ADDRESS_PATTERN = /^(?:[a-z0-9][a-z0-9._-]{0,31}\/)?t[0-9]{1,6}[a-z]{0,2}$/;
export const LocalTerminalAddressSchema = z.string().regex(LOCAL_TERMINAL_ADDRESS_PATTERN);
/** Live and finished terminals one facts update may carry. */
export const LOCAL_TERMINAL_FACTS_MAX = 2_000;

/**
 * Machines this core reaches over ssh (spec 2706 layer 7), with herdr-core's
 * own machine model. A name follows herdr-core's terminal-name rules; a
 * target is how ssh reaches it: `host`, `user@host`, `user@host:port`, or a
 * `Host` from `~/.ssh/config`. It never starts with `-`, so it can never be
 * read as an ssh option, and it carries no spaces or shell signs.
 */
export const LOCAL_MACHINE_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,31}$/;
export const LocalMachineNameSchema = z.string().regex(LOCAL_MACHINE_NAME_PATTERN);
export const SSH_TARGET_PATTERN = /^(?:[A-Za-z0-9_][A-Za-z0-9._-]{0,63}@)?(?:[A-Za-z0-9][A-Za-z0-9._-]{0,252}|\[[0-9A-Fa-f:.]{2,45}\])(?::[0-9]{1,5})?$/;
export const SshTargetSchema = z.string().min(1).max(255).regex(SSH_TARGET_PATTERN)
  .refine((target) => {
    const port = /:([0-9]{1,5})$/.exec(target.replace(/^.*\]/, ""))?.[1];
    return port === undefined || (Number(port) >= 1 && Number(port) <= 65_535);
  });
export const LOCAL_MACHINES_MAX = 64;
/**
 * How to reach a machine beyond its target (spec 2706 layer 7): a port, an
 * identity file on this Mac (a path, never its contents), a jump host, or
 * Tailscale SSH. The main process builds the ssh command from these; the
 * renderer never sends a command.
 */
export const SshIdentityPathSchema = z.string().min(3).max(1024).regex(/^(?:~\/|\/)[A-Za-z0-9._/-]+$/)
  .refine((path) => !path.split("/").includes(".."));
export const SshOptionsSchema = z.strictObject({
  port: z.number().int().min(1).max(65_535).optional(),
  identity: SshIdentityPathSchema.optional(),
  jump: SshTargetSchema.optional(),
  tailscaleSsh: z.boolean().optional(),
}).refine((options) => !options.tailscaleSsh || (!options.port && !options.identity && !options.jump));
export type SshOptions = z.infer<typeof SshOptionsSchema>;
/** A tailnet peer from `tailscale status`: names and state only. */
export const TailscalePeerSchema = z.strictObject({
  name: z.string().max(64),
  dnsName: z.string().max(253).regex(/^[A-Za-z0-9][A-Za-z0-9.-]*$/),
  os: z.string().max(32),
  online: z.boolean(),
  tailscaleSsh: z.boolean(),
});
export type TailscalePeer = z.infer<typeof TailscalePeerSchema>;
export const LocalMachineStateSchema = z.enum(["connecting", "connected", "needs_login", "unreachable"]);
/** herdr-core's id for an added machine's core. */
export const MachineCoreIdSchema = z.string().regex(/^[0-9a-f]{8,64}$/);
export const LocalMachineSchema = z.strictObject({
  name: LocalMachineNameSchema,
  target: z.string().max(255),
  state: LocalMachineStateSchema,
  temporary: z.boolean(),
  /** How the app reaches it, when it was added here: shown, and reused by Open in terminal. */
  ssh: z.lazy(() => SshOptionsSchema).optional(),
  /** Its core's version when last seen (spec 2706 layer 8). */
  version: z.string().max(32).regex(/^[0-9A-Za-z.+-]*$/).optional(),
  /** Its core's own id as herdr-core reports it: tells a machine apart from another added under the same name. */
  coreId: MachineCoreIdSchema.optional(),
});
export type LocalMachine = z.infer<typeof LocalMachineSchema>;
/** Why a machine could not be added: herdr-core's stable kinds, never its messages. */
export const LocalMachineAddFailureSchema = z.enum(["unreachable", "hc_missing", "incompatible", "name_taken", "already_added", "invalid", "unavailable"]);
export type LocalMachineAddFailure = z.infer<typeof LocalMachineAddFailureSchema>;
const AttachIdSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const Size = { cols: z.number().int().min(20).max(500), rows: z.number().int().min(5).max(200) };
const Ok = z.strictObject({ ok: z.boolean() });
// "not-installed": this build carries no local terminal runtime.
// "unavailable": the runtime exists but could not be reached or started.
/** Why starting a local terminal failed, as a bounded kind safe to show. */
export const LocalCreateFailureSchema = z.enum(["timeout", "busy", "disconnected", "refused", "protocol", "folder", "unknown"]);
export type LocalCreateFailure = z.infer<typeof LocalCreateFailureSchema>;

const UNAVAILABLE = ["not-installed", "unavailable", "version-mismatch"] as const;
const Unavailable = z.enum(UNAVAILABLE);
export type LocalTerminalUnavailable = z.infer<typeof Unavailable>;

// What the program in the terminal reported about itself through OSC 7501
// (herdr-core stores it as reported). Only the fixed vocabulary crosses IPC;
// the program's message is separately bounded and sanitized by the host.
export const LocalTerminalStatusSchema = z.enum(["idle", "working", "done", "blocked", "error"]);
export type LocalTerminalStatus = z.infer<typeof LocalTerminalStatusSchema>;

export const LocalTerminalSchema = z.strictObject({
  id: LocalTerminalIdSchema,
  title: z.string().max(256),
  status: LocalTerminalStatusSchema.nullable(),
  statusMessage: z.string().max(200).regex(/^[^\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]*$/).optional(),
});
export type LocalTerminal = z.infer<typeof LocalTerminalSchema>;

/**
 * One terminal's status facts from herdr-core's `events.subscribe` (spec 2706
 * layer 4): what the sidebar needs, nothing the program could use to reach
 * the window beyond a bounded, sanitized title.
 */
export const LocalTerminalFactSchema = z.strictObject({
  id: LocalTerminalAddressSchema,
  title: z.string().max(256),
  status: LocalTerminalStatusSchema.nullable(),
  statusMessage: z.string().max(200).regex(/^[^\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]*$/).optional(),
  statusAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
  turn: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  seenTurn: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
  finished: z.boolean(),
  finishedSeen: z.boolean().optional(),
  parent: LocalTerminalAddressSchema.optional(),
  agent: z.enum(["claude", "codex", "opencode", "pi"]).optional(),
  /** What runs in it now and where (sanitized, short), for the row's second line. */
  program: z.string().max(64).regex(/^[^\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]*$/).optional(),
  folder: z.string().max(96).regex(/^[^\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]*$/).optional(),
});
export type LocalTerminalFact = z.infer<typeof LocalTerminalFactSchema>;
const FactsSchema = z.array(LocalTerminalFactSchema).max(LOCAL_TERMINAL_FACTS_MAX);

/** Coding agents the Terminal window can start; the command line for each is fixed in the main process. */
export const LocalTerminalAgentSchema = z.enum(["claude", "codex", "opencode", "pi"]);
export type LocalTerminalAgent = z.infer<typeof LocalTerminalAgentSchema>;
// A folder under the user's home: relative, no `..`, no empty or dot segments.
export const LocalTerminalFolderSchema = z.string().min(1).max(1024)
  .refine((value) => !value.startsWith("/") && !/[\u0000\\]/.test(value)
    && value.split("/").every((part) => part !== "" && part !== "." && part !== ".."));
export const LocalTerminalNameSchema = z.string().min(1).max(64).regex(/^[^\u0000-\u001f\u007f-\u009f]+$/);
// Pasted images and files: at most 8 MB raw, as herdr-core accepts.
export const LOCAL_TERMINAL_PUT_MAX_BYTES = 8 * 1024 * 1024;
const PUT_BASE64_MAX = Math.ceil(LOCAL_TERMINAL_PUT_MAX_BYTES / 3) * 4;
const PutFileNameSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9._ -]+$/).refine((name) => name !== "." && name !== "..");

const MachineCoreResponse = z.union([
  z.strictObject({ ok: z.literal(true) }),
  z.strictObject({ ok: z.literal(false), reason: z.enum(["failed", "busy", "unavailable", "changed"]) }),
]);

export const LOCAL_TERMINAL_INVOKE = {
  "local-terminal:list": {
    request: z.strictObject({}),
    response: z.discriminatedUnion("status", [
      z.strictObject({ status: z.literal("ready"), terminals: z.array(LocalTerminalSchema).max(LOCAL_TERMINAL_LIST_MAX) }),
      z.strictObject({ status: Unavailable }),
    ]),
  },
  "local-terminal:create": {
    request: z.strictObject({
      ...Size,
      agent: LocalTerminalAgentSchema.optional(),
      folder: LocalTerminalFolderSchema.optional(),
      // A shell on a machine this core added, instead of this device.
      machine: LocalMachineNameSchema.optional(),
    }).refine((request) => !request.machine || (!request.agent && !request.folder)),
    response: z.discriminatedUnion("status", [
      z.strictObject({ status: z.literal("ready"), id: LocalTerminalAddressSchema }),
      // "rate-limited": too many terminals were started in a short time. `reason`: why a
      // start failed, as a bounded kind (never the core's own message), for the window to say.
      z.strictObject({ status: z.enum([...UNAVAILABLE, "rate-limited"]), reason: LocalCreateFailureSchema.optional() }),
    ]),
  },
  // Terminals here (`t7`) and on machines this core added (`vps/t7`) take the same actions.
  "local-terminal:kill": { request: z.strictObject({ id: LocalTerminalAddressSchema }), response: Ok },
  // Removes a finished terminal (herdr-core `terminal.rm`); a live one is refused by the core.
  "local-terminal:remove": { request: z.strictObject({ id: LocalTerminalAddressSchema }), response: Ok },
  "local-terminal:rename": { request: z.strictObject({ id: LocalTerminalAddressSchema, name: LocalTerminalNameSchema }), response: Ok },
  // Writes a pasted file beside the terminal (herdr-core `terminal.put`) and
  // returns where it landed, for the window to paste that path.
  "local-terminal:put": {
    request: z.strictObject({
      id: LocalTerminalAddressSchema,
      name: PutFileNameSchema,
      dataBase64: z.string().max(PUT_BASE64_MAX).regex(/^(?:[A-Za-z0-9+/]+={0,2})?$/), // "" is a zero-byte file
    }),
    response: z.union([
      z.strictObject({ ok: z.literal(true), path: z.string().min(1).max(4096) }),
      z.strictObject({ ok: z.literal(false) }),
    ]),
  },
  "local-terminal:attach": {
    request: z.strictObject({ id: LocalTerminalAddressSchema, ...Size }),
    response: z.union([
      z.strictObject({ ok: z.literal(true), attachId: AttachIdSchema }),
      z.strictObject({ ok: z.literal(false) }),
    ]),
  },
  "local-terminal:input": {
    // Binary input carries one byte per character; anything wider is refused
    // rather than silently truncated.
    request: z.strictObject({ attachId: AttachIdSchema, data: z.string().max(MAX_INPUT_CHARS), binary: z.boolean().optional() })
      .refine((input) => input.binary !== true || BYTE_STRING.test(input.data)),
    response: Ok,
  },
  "local-terminal:resize": { request: z.strictObject({ attachId: AttachIdSchema, ...Size }), response: Ok },
  // Output the window has taken, so the trusted core can let more through.
  "local-terminal:ack": {
    request: z.strictObject({ attachId: AttachIdSchema, count: z.number().int().min(1).max(LOCAL_TERMINAL_MAX_ACK_COUNT) }),
    response: Ok,
  },
  "local-terminal:detach": { request: z.strictObject({ attachId: AttachIdSchema }), response: Ok },
  // Starts following status (herdr-core `events.subscribe`) and returns what is known now;
  // later changes arrive as `local-terminal:facts`.
  "local-terminal:watch": {
    request: z.strictObject({}),
    response: z.discriminatedUnion("status", [
      z.strictObject({ status: z.literal("ready"), terminals: FactsSchema }),
      z.strictObject({ status: Unavailable }),
    ]),
  },
  "local-terminal:machines": {
    request: z.strictObject({}),
    response: z.discriminatedUnion("status", [
      z.strictObject({ status: z.literal("ready"), machines: z.array(LocalMachineSchema).max(LOCAL_MACHINES_MAX) }),
      z.strictObject({ status: Unavailable }),
    ]),
  },
  "local-terminal:machine-add": {
    request: z.strictObject({ target: SshTargetSchema, name: LocalMachineNameSchema.optional(), ssh: SshOptionsSchema.optional() }),
    response: z.union([
      z.strictObject({ ok: z.literal(true), machine: LocalMachineSchema }),
      z.strictObject({ ok: z.literal(false), reason: LocalMachineAddFailureSchema }),
    ]),
  },
  "local-terminal:machine-remove": { request: z.strictObject({ name: LocalMachineNameSchema }), response: Ok },
  "local-terminal:machine-connect": { request: z.strictObject({ name: LocalMachineNameSchema }), response: Ok },
  // Open in terminal for an added machine: ssh there the way it was added (target and options kept in the main process).
  "local-terminal:machine-login": {
    request: z.strictObject({ name: LocalMachineNameSchema, ...Size }),
    response: z.discriminatedUnion("status", [
      z.strictObject({ status: z.literal("ready"), id: LocalTerminalIdSchema }),
      z.strictObject({ status: z.enum([...UNAVAILABLE, "rate-limited"]) }),
    ]),
  },
  // Adds a machine that has no core (or an old one), installing the app's own core there (spec 2706 layer 8).
  "local-terminal:machine-install": {
    request: z.strictObject({ target: SshTargetSchema, name: LocalMachineNameSchema, ssh: SshOptionsSchema.optional() }),
    response: MachineCoreResponse,
  },
  // Replaces an added machine's core with the app's version; its terminals keep running.
  // The machine as it was listed when picked (its core's id, or its target and ssh fields): the
  // update refuses if the name now belongs to another machine.
  "local-terminal:machine-update": {
    request: z.strictObject({
      name: LocalMachineNameSchema, target: z.string().min(1).max(255),
      coreId: MachineCoreIdSchema.optional(), ssh: z.lazy(() => SshOptionsSchema).optional(),
    }),
    response: MachineCoreResponse,
  },
  // A terminal on this device running `ssh <target>`, where the person checks a new host key or types a password themselves.
  "local-terminal:ssh-login": {
    request: z.strictObject({ target: SshTargetSchema, ssh: SshOptionsSchema.optional(), ...Size }),
    response: z.discriminatedUnion("status", [
      z.strictObject({ status: z.literal("ready"), id: LocalTerminalIdSchema }),
      z.strictObject({ status: z.enum([...UNAVAILABLE, "rate-limited"]) }),
    ]),
  },
  // This Mac's tailnet peers, for one-click Add machine; Tailscale missing, stopped or logged out says so.
  "local-terminal:tailscale-peers": {
    request: z.strictObject({}),
    response: z.discriminatedUnion("status", [
      z.strictObject({ status: z.literal("ready"), peers: z.array(TailscalePeerSchema).max(256) }),
      z.strictObject({ status: z.enum(["missing", "stopped", "logged-out", "unavailable"]) }),
    ]),
  },
  // The person opened this terminal: herdr-core's `herdr.seen` label, shared with every client of the core.
  "local-terminal:seen": { request: z.strictObject({ id: LocalTerminalAddressSchema }), response: Ok },
} as const;

export const LOCAL_TERMINAL_EVENTS = {
  "local-terminal:output": z.strictObject({ attachId: AttachIdSchema, data: z.string().max(LOCAL_TERMINAL_MAX_OUTPUT_CHARS) }),
  "local-terminal:closed": z.strictObject({ attachId: AttachIdSchema }),
  "local-terminal:facts": z.strictObject({ terminals: FactsSchema }),
} as const;

export const LOCAL_TERMINAL_INVOKE_CHANNELS = Object.keys(LOCAL_TERMINAL_INVOKE) as Array<keyof typeof LOCAL_TERMINAL_INVOKE>;
export const LOCAL_TERMINAL_EVENT_CHANNELS = Object.keys(LOCAL_TERMINAL_EVENTS) as Array<keyof typeof LOCAL_TERMINAL_EVENTS>;
