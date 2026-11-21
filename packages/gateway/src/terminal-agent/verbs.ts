import { setTimeout as delay } from "node:timers/promises";
import {
  TerminalRefSchema,
  type TerminalRef,
  type TerminalTab,
  type TerminalWorkspace,
} from "@matrix-os/contracts";
import { z } from "zod/v4";
import { encodeTerminalKeys } from "./keys.js";
import { visibleTerminalText } from "./screen-text.js";
import type { TerminalInputActivity } from "./input-activity.js";

/** Herdr's status words, reported by agents about themselves. */
export const TerminalAgentStatusSchema = z.enum(["idle", "working", "done", "blocked", "error"]);
export type TerminalAgentStatus = z.infer<typeof TerminalAgentStatusSchema>;

export const TERMINAL_SEND_TEXT_MAX_CHARS = 8 * 1024;
export const TERMINAL_READ_LINES_MAX = 10_000;
export const TERMINAL_KEYS_MAX = 64;

const DEFAULT_QUIET_MS = 3_000;
const DEFAULT_DRAFT_WAIT_MS = 60_000;
const INTERRUPT_OBSERVE_MS = 5_000;
const INTERRUPT_POLL_MS = 250;
const PASTE_OPEN = "\x1b[200~";
const PASTE_CLOSE = "\x1b[201~";
// C0 controls (except tab and newline), DEL and C1 controls. ESC is included, so no
// sequence can be smuggled through a paste.
const UNSAFE_TEXT = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

export type TerminalAgentVerbErrorCode = "not_found" | "finished" | "blocked" | "invalid_request" | "cancelled";

export class TerminalAgentVerbError extends Error {
  constructor(readonly code: TerminalAgentVerbErrorCode) {
    super(`Terminal agent verb failed: ${code}`);
    this.name = "TerminalAgentVerbError";
  }
}

export interface TerminalAgentVerbRuntime {
  listWorkspaces(): Promise<TerminalWorkspace[]>;
  getSnapshot(ref: TerminalRef): Promise<unknown>;
  /** The screen read from zellij now; null or absent when only the snapshot is available. */
  captureScreen?(ref: TerminalRef, lines: number): Promise<unknown>;
  writeInput(ref: TerminalRef, data: string, expectedIncarnation?: string): Promise<void>;
}

const ScreenCaptureTextSchema = z.object({
  viewport: z.array(z.string().max(16_384)).max(500),
  scrollback: z.array(z.string().max(16_384)).max(TERMINAL_READ_LINES_MAX),
});

/**
 * A tab's live screen, or undefined to fall back to the cached snapshot. Zellij only
 * reports screen updates for panes a client renders, so a background tab's snapshot
 * can be minutes old; a runtime older than the capture operation rejects the call.
 */
export async function captureTerminalScreen(
  runtime: Pick<TerminalAgentVerbRuntime, "captureScreen">,
  ref: TerminalRef,
  lines: number,
): Promise<{ viewport: string[]; scrollback: string[] } | undefined> {
  if (!runtime.captureScreen) return undefined;
  try {
    const parsed = ScreenCaptureTextSchema.safeParse(await runtime.captureScreen(ref, lines));
    return parsed.success ? parsed.data : undefined;
  } catch (error: unknown) {
    console.warn("[gateway] terminal screen capture failed", error instanceof Error ? error.name : "unknown_error");
    return undefined;
  }
}

const SnapshotTextSchema = z.object({
  terminalRef: TerminalRefSchema,
  viewport: z.array(z.string().max(16_384)).max(200),
  scrollback: z.array(z.string().max(16_384)).max(100_000),
  updatedAt: z.string().max(64),
});

export interface TerminalReadResult {
  screen: string;
  history: string;
  lines: number;
  updatedAt?: string;
  incomplete?: true;
  why?: "unavailable";
}

export interface TerminalAgentFacts {
  tab: TerminalTab;
  state: "live" | "finished";
  agentStatus?: TerminalAgentStatus;
}

export interface TerminalAgentVerbs {
  get(ref: TerminalRef): Promise<TerminalAgentFacts>;
  read(ref: TerminalRef, input: { lines: number }): Promise<TerminalReadResult>;
  send(ref: TerminalRef, input: {
    text: string;
    force?: boolean;
    /** Most the send may wait for a person's draft; a caller with its own deadline lowers it. */
    maxHoldMs?: number;
    /** The caller went away: a held send is dropped instead of typed later. */
    signal?: AbortSignal;
    /** A background note: if a person is still typing when the hold ends, refuse (`cancelled`) instead of typing into the draft. */
    deferWhileTyping?: boolean;
  }): Promise<{ sent: true; heldMs: number }>;
  keys(ref: TerminalRef, input: { keys: string[] }): Promise<{ pressed: number }>;
  interrupt(ref: TerminalRef, input?: {
    /** The caller went away: stop looking for what the key did. */
    signal?: AbortSignal;
  }): Promise<TerminalInterruptResult>;
}

/** What changed within five seconds of the stop key; null when nothing did. */
export type TerminalInterruptObservation =
  | { status: TerminalAgentStatus }
  | { exited: true; exitCode?: number };

export interface TerminalInterruptResult {
  pressed: "esc" | "ctrl+c";
  observed: TerminalInterruptObservation | null;
}

/**
 * Herdr's terminal verbs (`get`, `read`, `send`, `keys`, `interrupt`) over a
 * canonical terminal workspace runtime. Only owner terminals are reachable:
 * Chat-bound and legacy tabs keep their own authorization paths.
 */
export function createTerminalAgentVerbs(options: {
  runtime: TerminalAgentVerbRuntime;
  inputActivity: TerminalInputActivity;
  agentStatus?: (ref: TerminalRef, tab: TerminalTab) => TerminalAgentStatus | undefined | Promise<TerminalAgentStatus | undefined>;
  /** Told after every successful send, so a following wait waits for the new turn. */
  onSent?: (ref: TerminalRef) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  quietMs?: number;
  draftWaitMs?: number;
}): TerminalAgentVerbs {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => delay(ms).then(() => undefined));
  const quietMs = options.quietMs ?? DEFAULT_QUIET_MS;
  const draftWaitMs = Math.min(options.draftWaitMs ?? DEFAULT_DRAFT_WAIT_MS, DEFAULT_DRAFT_WAIT_MS);

  async function requireTab(refInput: TerminalRef): Promise<TerminalTab> {
    const ref = TerminalRefSchema.parse(refInput);
    const workspace = (await options.runtime.listWorkspaces()).find((candidate) => candidate.id === ref.workspaceId);
    const tab = workspace?.tabs.find((candidate) => candidate.id === ref.tabId);
    if (!tab || tab.accessScope !== "owner") throw new TerminalAgentVerbError("not_found");
    return tab;
  }

  function isFinished(tab: TerminalTab): boolean {
    return tab.status === "exited" || tab.status === "failed";
  }

  async function requireLiveTab(ref: TerminalRef): Promise<TerminalTab> {
    const tab = await requireTab(ref);
    if (isFinished(tab)) throw new TerminalAgentVerbError("finished");
    return tab;
  }

  function write(ref: TerminalRef, tab: TerminalTab, data: string): Promise<void> {
    return options.runtime.writeInput(ref, data, tab.incarnation);
  }

  async function holdForDraft(ref: TerminalRef, limitMs: number, signal?: AbortSignal): Promise<number> {
    const start = now();
    for (;;) {
      if (signal?.aborted) throw new TerminalAgentVerbError("cancelled");
      const lastInput = options.inputActivity.lastInputAt(ref);
      const elapsed = now() - start;
      if (lastInput === undefined || now() - lastInput >= quietMs || elapsed >= limitMs) break;
      await sleep(Math.max(1, Math.min(quietMs - (now() - lastInput), limitMs - elapsed)));
    }
    if (signal?.aborted) throw new TerminalAgentVerbError("cancelled");
    return now() - start;
  }

  return {
    async get(ref) {
      const tab = await requireTab(ref);
      const agentStatus = await options.agentStatus?.(ref, tab);
      return { tab, state: isFinished(tab) ? "finished" : "live", ...(agentStatus ? { agentStatus } : {}) };
    },

    async read(ref, input) {
      const lines = z.number().int().min(0).max(TERMINAL_READ_LINES_MAX).parse(input.lines);
      await requireTab(ref);
      const live = await captureTerminalScreen(options.runtime, ref, lines);
      if (live) {
        const history = lines === 0 ? [] : live.scrollback.slice(-lines);
        return {
          screen: live.viewport.map(visibleTerminalText).join("\n"),
          history: history.map(visibleTerminalText).join("\n"),
          lines: history.length,
        };
      }
      const parsed = SnapshotTextSchema.safeParse(await options.runtime.getSnapshot(ref));
      if (!parsed.success
        || parsed.data.terminalRef.workspaceId !== ref.workspaceId
        || parsed.data.terminalRef.tabId !== ref.tabId) {
        return { screen: "", history: "", lines: 0, incomplete: true, why: "unavailable" };
      }
      const history = lines === 0 ? [] : parsed.data.scrollback.slice(-lines);
      return {
        screen: parsed.data.viewport.map(visibleTerminalText).join("\n"),
        history: history.map(visibleTerminalText).join("\n"),
        lines: history.length,
        updatedAt: parsed.data.updatedAt,
      };
    },

    async send(ref, input) {
      const text = sanitizeSendText(input.text);
      const tab = await requireLiveTab(ref);
      if (!input.force && await options.agentStatus?.(ref, tab) === "blocked") {
        throw new TerminalAgentVerbError("blocked");
      }
      const limitMs = Math.min(draftWaitMs, z.number().int().min(0).max(DEFAULT_DRAFT_WAIT_MS).parse(input.maxHoldMs ?? draftWaitMs));
      const heldMs = await holdForDraft(ref, limitMs, input.signal);
      if (input.deferWhileTyping) {
        const lastInput = options.inputActivity.lastInputAt(ref);
        if (lastInput !== undefined && now() - lastInput < quietMs) throw new TerminalAgentVerbError("cancelled");
      }
      const current = await requireLiveTab(ref);
      if (current.incarnation !== tab.incarnation) throw new TerminalAgentVerbError("not_found");
      // The agent may have asked for permission during the tab lookup or the draft hold,
      // so the last check runs right before every write, held or not.
      if (!input.force && await options.agentStatus?.(ref, current) === "blocked") {
        throw new TerminalAgentVerbError("blocked");
      }
      // Text and Enter in one write, so concurrent sends to a tab cannot interleave.
      // Newlines would submit line by line and tabs would trigger completion, so both paste.
      const paste = text.includes("\n") || text.includes("\t");
      await write(ref, current, `${paste ? `${PASTE_OPEN}${text}${PASTE_CLOSE}` : text}\r`);
      options.onSent?.(ref);
      return { sent: true, heldMs };
    },

    async keys(ref, input) {
      const keys = z.array(z.string()).min(1).max(TERMINAL_KEYS_MAX).parse(input.keys);
      let encoded: string;
      try { encoded = encodeTerminalKeys(keys); }
      catch (error: unknown) {
        if (error instanceof z.ZodError) throw new TerminalAgentVerbError("invalid_request");
        throw error;
      }
      const tab = await requireLiveTab(ref);
      await write(ref, tab, encoded);
      return { pressed: keys.length };
    },

    async interrupt(ref, input = {}) {
      const tab = await requireLiveTab(ref);
      const before = await options.agentStatus?.(ref, tab);
      // Esc stops an agent's turn; only a turn in progress has one to stop. A tab keeps
      // the last status its agent reported after that agent exits, so idle, done and
      // error mean a program started later in the shell, which needs Ctrl+C.
      const pressed = before === "working" || before === "blocked" ? "esc" : "ctrl+c";
      await write(ref, tab, pressed === "esc" ? "\x1b" : "\x03");
      // Look, never escalate: one key is pressed whatever happens next.
      const start = now();
      while (!input.signal?.aborted && now() - start < INTERRUPT_OBSERVE_MS) {
        await sleep(Math.min(INTERRUPT_POLL_MS, INTERRUPT_OBSERVE_MS - (now() - start)));
        if (input.signal?.aborted) break;
        let current: TerminalTab;
        try { current = await requireTab(ref); }
        catch (error: unknown) {
          if (error instanceof TerminalAgentVerbError) return { pressed, observed: { exited: true } };
          throw error;
        }
        if (current.incarnation !== tab.incarnation || isFinished(current)) {
          return { pressed, observed: { exited: true, ...(typeof current.exitCode === "number" ? { exitCode: current.exitCode } : {}) } };
        }
        const status = await options.agentStatus?.(ref, current);
        if (status !== undefined && status !== before) return { pressed, observed: { status } };
      }
      return { pressed, observed: null };
    },
  };
}

function sanitizeSendText(input: string): string {
  const text = z.string().min(1).max(TERMINAL_SEND_TEXT_MAX_CHARS).parse(input)
    .split(PASTE_OPEN).join("")
    .split(PASTE_CLOSE).join("")
    .replace(/\r\n?/g, "\n")
    .replace(UNSAFE_TEXT, "");
  if (text.trim() === "") throw new TerminalAgentVerbError("invalid_request");
  return text;
}
