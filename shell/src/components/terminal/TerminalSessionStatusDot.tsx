import type { CSSProperties } from "react";
import { getShellVisualStatus, TERMINAL_STATUS_LABEL, SHELL_WAITING_STATUS_DOT_STYLE, type ShellSessionSummary } from "./terminal-session-state";


/** Shared status and copy for plain reporter tabs as well as agent tabs. */
export function TerminalSessionStatusDot({ shell, style }: { shell: ShellSessionSummary; style?: CSSProperties }) {
  const status = getShellVisualStatus(shell);
  if (status === "idle") return null;
  return <span data-testid={`terminal-session-status-${shell.name}`} data-agent-status={status}
    title={TERMINAL_STATUS_LABEL[status]} style={{ borderRadius: "50%", flexShrink: 0,
      width: 8, height: 8, ...style,
      ...(status === "waiting" ? SHELL_WAITING_STATUS_DOT_STYLE : {
        background: status === "finished" ? "#3BA55D" : "var(--terminal-drawer-selected-stripe)",
      }),
    }} />;
}
