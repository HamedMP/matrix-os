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
 * full dump taken right after it. A full dump is history followed by exactly the
 * viewport rows, so with history both parts come from the full dump and the
 * viewport dump only gives the row count; output printed between the two dumps
 * then cannot repeat or drop rows.
 */
export function screenCaptureFromDumps(viewportDump: string, fullDump: string | undefined, lines: number): TerminalScreenCapture {
  const viewport = dumpRows(viewportDump).slice(-VIEWPORT_ROWS_MAX);
  if (fullDump === undefined || lines === 0) return { viewport, scrollback: [] };
  const full = dumpRows(fullDump);
  const split = Math.max(0, full.length - viewport.length);
  return { viewport: full.slice(split), scrollback: full.slice(0, split).slice(-lines) };
}

/**
 * A tab's screen read from zellij now. Zellij only reports screen updates for panes
 * some client renders, so the cached snapshot of a background tab can be stale.
 * Any tab that still names a pane is read, finished ones too: zellij holds an exited
 * program's pane with its final output until the tab is removed. A pane zellij already
 * closed fails the dump, and the caller falls back to the snapshot on null.
 */
export async function captureTabScreen(input: {
  workspace: { zellijSessionName: string; tabs: Record<string, { zellijPaneId?: string | null }> } | undefined;
  tabId: string;
  lines: number;
  dump: (sessionName: string, paneId: string, full: boolean) => Promise<string>;
}): Promise<TerminalScreenCapture | null> {
  const paneId = input.workspace?.tabs[input.tabId]?.zellijPaneId;
  if (!input.workspace || !paneId) return null;
  try {
    const viewport = await input.dump(input.workspace.zellijSessionName, paneId, false);
    const full = input.lines > 0 ? await input.dump(input.workspace.zellijSessionName, paneId, true) : undefined;
    return screenCaptureFromDumps(viewport, full, input.lines);
  } catch (error) {
    console.warn("[terminal-runtime] screen capture unavailable", error instanceof Error ? error.name : "unknown_error");
    return null;
  }
}
