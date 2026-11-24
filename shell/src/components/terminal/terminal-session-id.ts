import { TerminalRefSchema, type TerminalRef } from "@matrix-os/contracts";
import { isHerdrTerminalRef } from "@matrix-os/contracts/herdr-terminals";
import { desktopLinkDevicePrefix } from "@matrix-os/contracts/desktop-link";

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

/** Herdr terminals (spec 2701) and desktop terminals (spec 2716) attach through their own sockets with the same frames. */
export function terminalWebSocketPathForSession(value?: string | null): "/ws/terminal/tab" | "/ws/terminal/herdr" | "/ws/desktop-link/terminal" {
  const ref = parseTerminalRefKey(value);
  if (desktopLinkDevicePrefix(ref?.workspaceId)) return "/ws/desktop-link/terminal";
  return isHerdrTerminalRef(ref) ? "/ws/terminal/herdr" : "/ws/terminal/tab";
}
