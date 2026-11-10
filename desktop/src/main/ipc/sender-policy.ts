// Decides which window may call which IPC channel. A second window makes the
// generic handler's "any frame with the preload" trust a real exposure, so
// every invoke is checked against the sender's role (spec 651 FR-002).
import {
  TERMINAL_WINDOW_INVOKE_CHANNELS,
  TERMINAL_WINDOW_ONLY_INVOKE_CHANNELS,
} from "../../shared/terminal-window";

interface PolicyContents {
  isDestroyed(): boolean;
  getURL(): string;
  mainFrame: unknown;
}

interface PolicyWindow {
  isDestroyed(): boolean;
  webContents: PolicyContents;
}

export interface SenderPolicyOptions {
  mainWindow(): PolicyWindow | null;
  terminalWindow(): PolicyWindow | null;
  mainUrl: string;
  terminalUrl: string;
}

export type SenderRole = "main" | "terminal";
export type SenderAuthorizer = (event: unknown, channel: string) => boolean;

const terminalAllowed = new Set<string>(TERMINAL_WINDOW_INVOKE_CHANNELS);
const terminalOnly = new Set<string>(TERMINAL_WINDOW_ONLY_INVOKE_CHANNELS);

function isSenderOf(event: unknown, win: PolicyWindow | null, trustedUrl: string): boolean {
  if (!win || win.isDestroyed()) return false;
  const contents = win.webContents;
  if (contents.isDestroyed()) return false;
  const candidate = event as { sender?: unknown; senderFrame?: unknown } | null;
  return !!candidate && candidate.sender === contents
    && candidate.senderFrame === contents.mainFrame && contents.getURL() === trustedUrl;
}

export function senderRole(options: SenderPolicyOptions, event: unknown): SenderRole | null {
  if (isSenderOf(event, options.mainWindow(), options.mainUrl)) return "main";
  if (isSenderOf(event, options.terminalWindow(), options.terminalUrl)) return "terminal";
  return null;
}

export function createSenderPolicy(options: SenderPolicyOptions): SenderAuthorizer {
  return (event, channel) => {
    const role = senderRole(options, event);
    if (role === "main") return !terminalOnly.has(channel);
    if (role === "terminal") return terminalAllowed.has(channel);
    return false;
  };
}
