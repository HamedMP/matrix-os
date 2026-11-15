import type { CSSProperties } from "react";
import { TERMINAL_FINISHED_DOT_COLOR, TERMINAL_STATUS_LABEL, TERMINAL_WAITING_DOT_STYLE, type TerminalShellVisualStatus } from "./shell-status.js";

/** Shared status dot for terminal tab rows; nothing is shown for an idle tab. */
export function TerminalStatusDot({ status, testId, runningColor = "var(--terminal-drawer-selected-stripe)", style }: {
  status: TerminalShellVisualStatus; testId?: string; runningColor?: string; style?: CSSProperties;
}) {
  if (status === "idle") return null;
  return <span data-testid={testId} data-agent-status={status}
    title={TERMINAL_STATUS_LABEL[status]} style={{ borderRadius: "50%", flexShrink: 0,
      width: 8, height: 8, ...style,
      ...(status === "waiting" ? TERMINAL_WAITING_DOT_STYLE : {
        background: status === "finished" ? TERMINAL_FINISHED_DOT_COLOR : runningColor,
      }),
    }} />;
}
