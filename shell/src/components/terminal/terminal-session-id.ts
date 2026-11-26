import { TerminalRefSchema, type TerminalRef } from "@matrix-os/contracts";
import { isHerdrTerminalRef } from "@matrix-os/contracts/herdr-terminals";

const TERMINAL_REF_SEPARATOR = ":";

export function terminalRefKey(ref: TerminalRef): string {
  const parsed = TerminalRefSchema.parse(ref);
  return `${parsed.workspaceId}${TERMINAL_REF_SEPARATOR}${parsed.tabId}`;
}

export function parseTerminalRefKey(value: string | null | undefined): TerminalRef | null {
  if (!value) return null;
  const [workspaceId, tabId, extra] = value.split(TERMINAL_REF_SEPARATOR);
  if (extra !== undefined) return null;
  const parsed = TerminalRefSchema.safeParse({ workspaceId, tabId });
  return parsed.success ? parsed.data : null;
}

export function isCanonicalShellSessionId(value: string): boolean {
  return parseTerminalRefKey(value) !== null;
}

/** Herdr terminals (spec 2701) attach through their own socket with the same frames. */
export function terminalWebSocketPathForSession(value?: string | null): "/ws/terminal/tab" | "/ws/terminal/herdr" {
  return isHerdrTerminalRef(parseTerminalRefKey(value)) ? "/ws/terminal/herdr" : "/ws/terminal/tab";
}
