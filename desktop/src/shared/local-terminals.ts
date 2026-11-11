// IPC contract for local terminals in the Terminal window (spec 651 FR-008).
// The renderer names terminals and sends keystrokes; it never sees the
// herdr-core socket, its path, or raw JSON-RPC.
import { z } from "zod/v4";

export const LOCAL_TERMINAL_VERSION = "0.1.19";
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
const AttachIdSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const Size = { cols: z.number().int().min(20).max(500), rows: z.number().int().min(5).max(200) };
const Ok = z.object({ ok: z.boolean() }).strict();
// "not-installed": this build carries no local terminal runtime.
// "unavailable": the runtime exists but could not be reached or started.
const UNAVAILABLE = ["not-installed", "unavailable", "version-mismatch"] as const;
const Unavailable = z.enum(UNAVAILABLE);
export type LocalTerminalUnavailable = z.infer<typeof Unavailable>;

// What the program in the terminal reported about itself through OSC 7501
// (herdr-core stores it as reported). Only the fixed vocabulary crosses IPC;
// the program's free text does not.
export const LocalTerminalStatusSchema = z.enum(["idle", "working", "done", "blocked", "error"]);
export type LocalTerminalStatus = z.infer<typeof LocalTerminalStatusSchema>;

export const LocalTerminalSchema = z.object({
  id: LocalTerminalIdSchema,
  title: z.string().max(256),
  status: LocalTerminalStatusSchema.nullable(),
}).strict();
export type LocalTerminal = z.infer<typeof LocalTerminalSchema>;

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

export const LOCAL_TERMINAL_INVOKE = {
  "local-terminal:list": {
    request: z.object({}).strict(),
    response: z.discriminatedUnion("status", [
      z.object({ status: z.literal("ready"), terminals: z.array(LocalTerminalSchema).max(LOCAL_TERMINAL_LIST_MAX) }).strict(),
      z.object({ status: Unavailable }).strict(),
    ]),
  },
  "local-terminal:create": {
    request: z.object({
      ...Size,
      agent: LocalTerminalAgentSchema.optional(),
      folder: LocalTerminalFolderSchema.optional(),
    }).strict(),
    response: z.discriminatedUnion("status", [
      z.object({ status: z.literal("ready"), id: LocalTerminalIdSchema }).strict(),
      // "rate-limited": too many terminals were started in a short time.
      z.object({ status: z.enum([...UNAVAILABLE, "rate-limited"]) }).strict(),
    ]),
  },
  "local-terminal:kill": { request: z.object({ id: LocalTerminalIdSchema }).strict(), response: Ok },
  "local-terminal:rename": { request: z.object({ id: LocalTerminalIdSchema, name: LocalTerminalNameSchema }).strict(), response: Ok },
  // Writes a pasted file beside the terminal (herdr-core `terminal.put`) and
  // returns where it landed, for the window to paste that path.
  "local-terminal:put": {
    request: z.object({
      id: LocalTerminalIdSchema,
      name: PutFileNameSchema,
      dataBase64: z.string().min(1).max(PUT_BASE64_MAX).regex(/^[A-Za-z0-9+/]+={0,2}$/),
    }).strict(),
    response: z.union([
      z.object({ ok: z.literal(true), path: z.string().min(1).max(4096) }).strict(),
      z.object({ ok: z.literal(false) }).strict(),
    ]),
  },
  "local-terminal:attach": {
    request: z.object({ id: LocalTerminalIdSchema, ...Size }).strict(),
    response: z.union([
      z.object({ ok: z.literal(true), attachId: AttachIdSchema }).strict(),
      z.object({ ok: z.literal(false) }).strict(),
    ]),
  },
  "local-terminal:input": {
    // Binary input carries one byte per character; anything wider is refused
    // rather than silently truncated.
    request: z.object({ attachId: AttachIdSchema, data: z.string().max(MAX_INPUT_CHARS), binary: z.boolean().optional() }).strict()
      .refine((input) => input.binary !== true || BYTE_STRING.test(input.data)),
    response: Ok,
  },
  "local-terminal:resize": { request: z.object({ attachId: AttachIdSchema, ...Size }).strict(), response: Ok },
  // Output the window has taken, so the trusted core can let more through.
  "local-terminal:ack": {
    request: z.object({ attachId: AttachIdSchema, count: z.number().int().min(1).max(LOCAL_TERMINAL_MAX_ACK_COUNT) }).strict(),
    response: Ok,
  },
  "local-terminal:detach": { request: z.object({ attachId: AttachIdSchema }).strict(), response: Ok },
} as const;

export const LOCAL_TERMINAL_EVENTS = {
  "local-terminal:output": z.object({ attachId: AttachIdSchema, data: z.string().max(LOCAL_TERMINAL_MAX_OUTPUT_CHARS) }).strict(),
  "local-terminal:closed": z.object({ attachId: AttachIdSchema }).strict(),
} as const;

export const LOCAL_TERMINAL_INVOKE_CHANNELS = Object.keys(LOCAL_TERMINAL_INVOKE) as Array<keyof typeof LOCAL_TERMINAL_INVOKE>;
export const LOCAL_TERMINAL_EVENT_CHANNELS = Object.keys(LOCAL_TERMINAL_EVENTS) as Array<keyof typeof LOCAL_TERMINAL_EVENTS>;
