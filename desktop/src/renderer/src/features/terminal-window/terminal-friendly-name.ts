// The name a confirm shows for a terminal (ENG-521): its agent topic or tab
// name, never a raw shell prompt title such as `me@host:~`.
import type { TerminalSidebarRow } from "@matrix-os/ui/terminal-status-sidebar";

/** A title the shell set from its prompt: `user@host: ~/dir`, `user@host:~$`, or ending in a prompt sign. */
const PROMPT_TITLE = /^[\w.-]+@[\w.-]+(?::|\s|$)|[$#%>]\s*$/;

export function friendlyTerminalName(row: Pick<TerminalSidebarRow, "name" | "space"> | undefined): string {
  const name = row?.name.trim() ?? "";
  if (name && !PROMPT_TITLE.test(name)) return name;
  return row?.space ? `Terminal in ${row.space}` : "Terminal";
}
