// What a herdr-core terminal looks like once it leaves the core: an id in the
// core's own format, a bounded title, and what the program reported about
// itself through OSC 7501 (herdr-core stores it as reported). Shared by every
// host that lists herdr-core terminals: Electron Desktop and the gateway.
import { z } from "zod/v4";

// Terminals are not count-capped. This bounds one listing, and matches the
// most the core reports.
export const HC_TERMINAL_LIST_MAX = 1_000;
export const HC_TERMINAL_MAX_OUTPUT_CHARS = 262_144;
export const HC_TERMINAL_ID_PATTERN = /^t[0-9]{1,6}[a-z]{0,2}$/;
export const HcTerminalIdSchema = z.string().regex(HC_TERMINAL_ID_PATTERN);
/**
 * A terminal this core reports, here (`t7`) or on a machine it added
 * (`vps/t7`); machine names follow herdr-core's terminal-name rules.
 */
export const HC_TERMINAL_ADDRESS_PATTERN = /^(?:[a-z0-9][a-z0-9._-]{0,31}\/)?t[0-9]{1,6}[a-z]{0,2}$/;

export const HcTerminalStatusSchema = z.enum(["idle", "working", "done", "blocked", "error"]);
export type HcTerminalStatus = z.infer<typeof HcTerminalStatusSchema>;

export const HcTerminalSchema = z.strictObject({
  id: HcTerminalIdSchema,
  title: z.string().max(256),
  status: HcTerminalStatusSchema.nullable(),
  statusMessage: z.string().max(200).regex(/^[^\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]*$/).optional(),
});
export type HcTerminal = z.infer<typeof HcTerminalSchema>;
