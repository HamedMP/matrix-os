import { z } from "zod/v4";

/** Runs one `zellij --session <name> action ...` command with the given timeout. */
export type ZellijSessionAction = (args: string[]) => Promise<string>;

const ListedPaneSchema = z.object({
  id: z.number().int().min(0),
  is_plugin: z.boolean(),
  tab_id: z.number().int().min(0),
}).passthrough();

/** The pane each attached client shows, from `list-clients`; empty when unknown. */
export async function readClientPanes(action: ZellijSessionAction): Promise<Map<string, string>> {
  const panes = new Map<string, string>();
  try {
    for (const line of (await action(["list-clients"])).split("\n")) {
      const match = /^\s*(\d+)\s+(terminal_\d+)\b/.exec(line);
      if (match) panes.set(match[1]!, match[2]!);
    }
  } catch (error) {
    console.warn("[terminal-runtime] client list unavailable", error instanceof Error ? error.name : "unknown_error");
  }
  return panes;
}

/**
 * Zellij focuses a new tab for the active client, even with independent focus, so a
 * tab created in the background would move a person's view to it. Focus actions apply
 * to that same active client, so focusing the pane it showed returns it. Only a client
 * now on a pane of the new tab counts as moved: one that switched to another pane while
 * the tab was being created chose that pane and stays there.
 * Best effort: tab creation never fails over a viewer that could not be returned.
 */
export async function returnViewerMovedToNewTab(input: {
  action: ZellijSessionAction;
  before: Map<string, string>;
  newTabId: number;
}): Promise<void> {
  if (input.before.size === 0) return;
  const after = await readClientPanes(input.action);
  const changed = [...after].filter(([client, pane]) => input.before.has(client) && input.before.get(client) !== pane);
  if (changed.length === 0) return;
  try {
    const listed = z.array(ListedPaneSchema).max(10_000).parse(JSON.parse(await input.action(["list-panes", "--all", "--json"])));
    const newTabPanes = new Set(listed.filter((pane) => !pane.is_plugin && pane.tab_id === input.newTabId).map((pane) => `terminal_${pane.id}`));
    const moved = changed.find(([, pane]) => newTabPanes.has(pane));
    if (!moved) return;
    await input.action(["focus-pane-id", input.before.get(moved[0])!]);
  } catch (error) {
    console.warn("[terminal-runtime] could not return a moved viewer", error instanceof Error ? error.name : "unknown_error");
  }
}
