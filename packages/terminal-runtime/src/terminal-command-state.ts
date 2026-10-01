import { TerminalRefSchema } from "@matrix-os/contracts";
import { z } from "zod/v4";

export const TerminalCommandStateSchema = z.enum(["running", "exited", "unknown"]);
export type TerminalCommandState = z.infer<typeof TerminalCommandStateSchema>;
export const TerminalCommandStateRefSchema = TerminalRefSchema.extend({
  expectedIncarnation: z.string().regex(/^ti_[a-f0-9]{32}$/).optional(),
}).strict();

const PaneStateSchema = z.object({
  id: z.number().int().min(0),
  tab_id: z.number().int().min(0),
  is_plugin: z.boolean(),
  is_held: z.boolean().optional(),
  exit_status: z.number().int().nullable().optional(),
}).passthrough();
const PaneStatesSchema = z.array(PaneStateSchema).max(10_000);

/** Infer only from explicit current held/exit evidence for the exact managed pane. */
export function terminalCommandStateFromPanes(value: unknown, tabId: number, paneId: string): TerminalCommandState {
  const parsed = PaneStatesSchema.safeParse(value);
  if (!parsed.success) return "unknown";
  const matches = parsed.data.filter((pane) => !pane.is_plugin && pane.tab_id === tabId
    && `terminal_${pane.id}` === paneId);
  if (matches.length !== 1) return "unknown";
  const pane = matches[0]!;
  if (pane.is_held === true && typeof pane.exit_status === "number") return "exited";
  if (pane.is_held === false && pane.exit_status === null) return "running";
  return "unknown";
}
