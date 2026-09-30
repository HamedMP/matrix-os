import type { ShellSessionSummary } from "./terminal-session-state";

/** Group key for sessions that do not belong to a project. */
export const MAIN_TERMINAL_PROJECT = "main";

/**
 * Groups shell sessions by their owning project in first-seen order, the way
 * every terminal sidebar presents project sessions (and their project Share
 * control). Sessions without a project belong to Main.
 */
export function groupShellSessionsByProject(
  shells: ShellSessionSummary[],
): Array<[project: string, sessions: ShellSessionSummary[]]> {
  return Object.entries(Object.groupBy(shells, (shell) => shell.project || MAIN_TERMINAL_PROJECT))
    .flatMap(([project, sessions]) => (sessions ? [[project, sessions] as [string, ShellSessionSummary[]]] : []));
}
