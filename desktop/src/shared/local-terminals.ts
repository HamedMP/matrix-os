// IPC contract for local terminals in the Terminal window (spec 651 FR-008).
// The renderer names terminals and sends keystrokes; it never sees the
// herdr-core socket, its path, or raw JSON-RPC.
import { z } from "zod/v4";
import {
  HC_TERMINAL_ID_PATTERN, HC_TERMINAL_LIST_MAX, HcTerminalIdSchema, HcTerminalSchema, HcTerminalStatusSchema,
  type HcTerminal, type HcTerminalStatus,
} from "@matrix-os/herdr-core-client/terminal";

export const LOCAL_TERMINAL_LIST_MAX = HC_TERMINAL_LIST_MAX;
export const LOCAL_TERMINAL_ID_PATTERN = HC_TERMINAL_ID_PATTERN;

export const LOCAL_TERMINAL_VERSION = "0.1.19";
export const LOCAL_TERMINAL_SESSION_PREFIX = "local:";
const MAX_INPUT_CHARS = 65_536;
/** The most output events one acknowledgement may cover; larger batches are split. */
export const LOCAL_TERMINAL_MAX_ACK_COUNT = 4_096;
const BYTE_STRING = /^[\u0000-\u00ff]*$/;

export const LocalTerminalIdSchema = HcTerminalIdSchema;
const AttachIdSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const Size = { cols: z.number().int().min(20).max(500), rows: z.number().int().min(5).max(200) };
const Ok = z.strictObject({ ok: z.boolean() });
// "not-installed": this build carries no local terminal runtime.
// "unavailable": the runtime exists but could not be reached or started.
const UNAVAILABLE = ["not-installed", "unavailable", "version-mismatch"] as const;
const Unavailable = z.enum(UNAVAILABLE);
export type LocalTerminalUnavailable = z.infer<typeof Unavailable>;

// What the program in the terminal reported about itself through OSC 7501
// (herdr-core stores it as reported). The shape is shared with the gateway.
export const LocalTerminalStatusSchema = HcTerminalStatusSchema;
export type LocalTerminalStatus = HcTerminalStatus;
export const LocalTerminalSchema = HcTerminalSchema;
export type LocalTerminal = HcTerminal;

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
    }),
    response: z.discriminatedUnion("status", [
      z.strictObject({ status: z.literal("ready"), id: LocalTerminalIdSchema }),
      // "rate-limited": too many terminals were started in a short time.
      z.strictObject({ status: z.enum([...UNAVAILABLE, "rate-limited"]) }),
    ]),
  },
  "local-terminal:kill": { request: z.strictObject({ id: LocalTerminalIdSchema }), response: Ok },
  "local-terminal:rename": { request: z.strictObject({ id: LocalTerminalIdSchema, name: LocalTerminalNameSchema }), response: Ok },
  // Writes a pasted file beside the terminal (herdr-core `terminal.put`) and
  // returns where it landed, for the window to paste that path.
  "local-terminal:put": {
    request: z.strictObject({
      id: LocalTerminalIdSchema,
      name: PutFileNameSchema,
      dataBase64: z.string().max(PUT_BASE64_MAX).regex(/^(?:[A-Za-z0-9+/]+={0,2})?$/), // "" is a zero-byte file
    }),
    response: z.union([
      z.strictObject({ ok: z.literal(true), path: z.string().min(1).max(4096) }),
      z.strictObject({ ok: z.literal(false) }),
    ]),
  },
  "local-terminal:attach": {
    request: z.strictObject({ id: LocalTerminalIdSchema, ...Size }),
    response: z.union([
      z.strictObject({ ok: z.literal(true), attachId: AttachIdSchema }),
      z.strictObject({ ok: z.literal(false) }),
    ]),
  },
  "local-terminal:resize": { request: z.strictObject({ attachId: AttachIdSchema, ...Size }), response: Ok },
  "local-terminal:detach": { request: z.strictObject({ attachId: AttachIdSchema }), response: Ok },
} as const;

// Output, typing and acknowledgements of one attachment travel over a
// MessagePort of its own, which the trusted core hands to the Terminal
// window's preload only (spec 2701 layer 6): output stays bytes from the core
// to xterm, and nothing is routed through every listener in the window.
export const LOCAL_TERMINAL_PORT_CHANNEL = "local-terminal:port";
/** What accompanies an attachment's port. */
export const LocalTerminalPortSchema = z.strictObject({ attachId: AttachIdSchema });
/** The most output one message may carry: herdr-core's frame cap. */
export const LOCAL_TERMINAL_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
/** What the window sends over an attachment's port. Main validates it again. */
export const LocalTerminalStreamRequestSchema = z.discriminatedUnion("type", [
  // Binary input carries one byte per character; anything wider is refused
  // rather than silently truncated.
  z.strictObject({ type: z.literal("input"), data: z.string().max(MAX_INPUT_CHARS), binary: z.boolean().optional() })
    .refine((input) => input.binary !== true || BYTE_STRING.test(input.data)),
  // Output the window has taken, so the trusted core can let more through.
  z.strictObject({ type: z.literal("ack"), count: z.number().int().min(1).max(LOCAL_TERMINAL_MAX_ACK_COUNT) }),
]);
export type LocalTerminalStreamRequest = z.infer<typeof LocalTerminalStreamRequestSchema>;
/** Main tells the window the attachment has ended; every other message is output bytes. */
export const LOCAL_TERMINAL_STREAM_CLOSED = { type: "closed" } as const;


export const LOCAL_TERMINAL_INVOKE_CHANNELS = Object.keys(LOCAL_TERMINAL_INVOKE) as Array<keyof typeof LOCAL_TERMINAL_INVOKE>;
