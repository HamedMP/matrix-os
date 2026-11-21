import type { CSSProperties } from "react";
import { TerminalStatusDot } from "@matrix-os/ui/terminal-agents";
import { getShellVisualStatus, type ShellSessionSummary } from "./terminal-session-state";

/** Shared status and copy for plain reporter tabs as well as agent tabs. */
export function TerminalSessionStatusDot({ shell, style }: { shell: ShellSessionSummary; style?: CSSProperties }) {
  return <TerminalStatusDot status={getShellVisualStatus(shell)} testId={`terminal-session-status-${shell.name}`} style={style} />;
}
