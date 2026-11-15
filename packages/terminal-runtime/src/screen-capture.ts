import { TerminalRefSchema } from "@matrix-os/contracts";
import { z } from "zod/v4";

/** History lines one capture may return; matches the gateway's read limit. */
export const TERMINAL_SCREEN_CAPTURE_LINES_MAX = 10_000;
const ROW_MAX_CHARS = 16_384;
const VIEWPORT_ROWS_MAX = 500;

export const TerminalScreenCaptureRequestSchema = TerminalRefSchema.extend({
  lines: z.number().int().min(0).max(TERMINAL_SCREEN_CAPTURE_LINES_MAX),
}).strict();
export type TerminalScreenCaptureRequest = z.infer<typeof TerminalScreenCaptureRequestSchema>;

export const TerminalScreenCaptureSchema = z.object({
  viewport: z.array(z.string().max(ROW_MAX_CHARS)).max(VIEWPORT_ROWS_MAX),
  scrollback: z.array(z.string().max(ROW_MAX_CHARS)).max(TERMINAL_SCREEN_CAPTURE_LINES_MAX),
}).strict();
export type TerminalScreenCapture = z.infer<typeof TerminalScreenCaptureSchema>;

/** Rows of a plain `dump-screen`, whose CLI output ends with one extra LF. */
function dumpRows(stdout: string): string[] {
  const text = stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout;
  if (text === "") return [];
  return text.split(/\r?\n/).map((row) => row.slice(0, ROW_MAX_CHARS));
}

/**
 * The screen of a pane from a viewport dump and, when history was asked for, a
 * full dump taken right after it. History is the full dump minus the viewport rows.
 */
export function screenCaptureFromDumps(viewportDump: string, fullDump: string | undefined, lines: number): TerminalScreenCapture {
  const viewport = dumpRows(viewportDump).slice(-VIEWPORT_ROWS_MAX);
  if (fullDump === undefined || lines === 0) return { viewport, scrollback: [] };
  const full = dumpRows(fullDump);
  const history = full.slice(0, Math.max(0, full.length - viewport.length));
  return { viewport, scrollback: history.slice(-lines) };
}
