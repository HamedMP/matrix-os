import { setTimeout as delay } from "node:timers/promises";
import { TerminalRefSchema, type TerminalRef, type TerminalTab } from "@matrix-os/contracts";
import { z } from "zod/v4";
import type { TerminalAgentStatusSource } from "./status-source.js";
import { terminalRefKey } from "./status-source.js";
import { visibleTerminalText } from "./screen-text.js";
import { captureTerminalScreen, TerminalAgentVerbError, type TerminalAgentStatus, type TerminalAgentVerbRuntime } from "./verbs.js";

/** One HTTP wait stays below common proxy idle limits; callers wait again after a check-in. */
export const TERMINAL_WAIT_MAX_MS = 90_000;
export const TERMINAL_WAIT_DEFAULT_MS = 60_000;
export const TERMINAL_WAIT_OUTPUT_MAX_CHARS = 256;
const DEFAULT_POLL_MS = 500;
// History each output poll reads. Output that scrolls further than this between two
// polls (500 ms) is not counted; the full scrollback on every poll would cost more.
const WAIT_OUTPUT_HISTORY_LINES = 2_000;
// Failed captures, with none succeeding, before a wait reads the snapshot instead.
const LIVE_CAPTURE_ATTEMPTS = 3;
const MAX_WAITERS = 256;
const MAX_WAITERS_PER_TAB = 16;

export type TerminalWaitResult =
  | { reason: "stopped"; status: TerminalAgentStatus }
  | { reason: "exited"; exitCode: number | null }
  | { reason: "output" }
  /** `seen`: how often `output` had appeared, to pass back on the next wait. */
  | { reason: "timeout"; status?: TerminalAgentStatus; seen?: number }
  | { reason: "cancelled" }
  | { reason: "shutdown" };

export class TerminalWaitCapacityError extends Error {
  readonly code = "capacity";
  constructor() {
    super("Too many terminal waits");
    this.name = "TerminalWaitCapacityError";
  }
}

export interface TerminalWaiter {
  wait(ref: TerminalRef, input: { output?: string; seen?: number; timeoutMs?: number; signal?: AbortSignal }): Promise<TerminalWaitResult>;
  shutdown(): void;
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  for (let index = haystack.indexOf(needle); index !== -1; index = haystack.indexOf(needle, index + needle.length)) count += 1;
  return count;
}

/**
 * Herdr's `wait`: until the program stops working (any reported word but
 * `working`), exits, or prints `output` after the wait began. A program that
 * never reported a status counts as working until it exits.
 */
export function createTerminalWaiter(options: {
  runtime: Pick<TerminalAgentVerbRuntime, "listWorkspaces" | "getSnapshot" | "captureScreen">;
  status: TerminalAgentStatusSource;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  pollMs?: number;
}): TerminalWaiter {
  const now = options.now ?? Date.now;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const sleep = options.sleep ?? ((ms: number, signal: AbortSignal) => delay(ms, undefined, { signal }).then(
    () => undefined,
    (error: unknown) => {
      if (error instanceof Error && error.name === "AbortError") return;
      throw error;
    },
  ));
  const shutdownController = new AbortController();
  const perTab = new Map<string, number>();
  let total = 0;

  async function findTab(ref: TerminalRef): Promise<TerminalTab> {
    const workspace = (await options.runtime.listWorkspaces()).find((candidate) => candidate.id === ref.workspaceId);
    const tab = workspace?.tabs.find((candidate) => candidate.id === ref.tabId);
    if (!tab || tab.accessScope !== "owner") throw new TerminalAgentVerbError("not_found");
    return tab;
  }

  async function liveText(ref: TerminalRef): Promise<string | undefined> {
    const live = await captureTerminalScreen(options.runtime, ref, WAIT_OUTPUT_HISTORY_LINES);
    return live ? [...live.scrollback, ...live.viewport].map(visibleTerminalText).join("\n") : undefined;
  }

  async function snapshotText(ref: TerminalRef): Promise<string> {
    const snapshot = z.object({
      viewport: z.array(z.string()).max(200),
      scrollback: z.array(z.string()).max(100_000),
    }).safeParse(await options.runtime.getSnapshot(ref));
    // Match what the terminal shows: snapshot rows keep their colour codes.
    return snapshot.success ? [...snapshot.data.scrollback, ...snapshot.data.viewport].map(visibleTerminalText).join("\n") : "";
  }

  async function run(ref: TerminalRef, input: { output?: string; seen?: number; timeoutMs: number; signal?: AbortSignal }): Promise<TerminalWaitResult> {
    const deadline = now() + input.timeoutMs;
    // One read source per request: a frozen snapshot can lack text the live screen
    // shows, so counts from the two never mix. A runtime that can capture is read live,
    // and a failed capture skips that poll. Only a runtime that has never captured in
    // this request (unsupported, or older than the gateway) falls back to the snapshot.
    let source: "live" | "snapshot" = options.runtime.captureScreen ? "live" : "snapshot";
    let liveSeen = false;
    let liveFailures = 0;
    const readText = async (): Promise<string | undefined> => {
      if (source === "live") {
        const live = await liveText(ref);
        if (live !== undefined) {
          liveSeen = true;
          return live;
        }
        liveFailures += 1;
        if (liveSeen || liveFailures < LIVE_CAPTURE_ATTEMPTS) return undefined;
        source = "snapshot";
      }
      return snapshotText(ref);
    };
    // A follow-up request continues the caller's baseline, so text printed between
    // two check-ins still counts as new. Otherwise the first successful read sets it.
    let baseline = input.seen;
    if (input.output && baseline === undefined) {
      const text = await readText();
      if (text !== undefined) baseline = countOccurrences(text, input.output);
    }
    const signal = input.signal ? AbortSignal.any([input.signal, shutdownController.signal]) : shutdownController.signal;
    let lastStatus: TerminalAgentStatus | undefined;
    for (;;) {
      if (shutdownController.signal.aborted) return { reason: "shutdown" };
      if (input.signal?.aborted) return { reason: "cancelled" };
      const tab = await findTab(ref);
      if (tab.status === "exited" || tab.status === "failed") return { reason: "exited", exitCode: tab.exitCode ?? null };
      if (input.output) {
        const text = await readText();
        if (text !== undefined) {
          const count = countOccurrences(text, input.output);
          if (baseline !== undefined && count > baseline) return { reason: "output" };
          // A read holds only recent history: matches that scrolled out (or a cleared
          // screen) lower the count, so the baseline drops with it and the next match
          // still counts. Missed only if an old match leaves and a new one arrives
          // between two polls 500 ms apart, i.e. thousands of lines in that time.
          baseline = count;
        }
      } else {
        lastStatus = (await options.status.get(ref))?.status;
        if (lastStatus && lastStatus !== "working") return { reason: "stopped", status: lastStatus };
      }
      const remaining = deadline - now();
      if (remaining <= 0) {
        return { reason: "timeout", ...(lastStatus ? { status: lastStatus } : {}), ...(input.output ? { seen: baseline ?? 0 } : {}) };
      }
      await sleep(Math.min(pollMs, remaining), signal);
    }
  }

  return {
    wait(refInput, input) {
      const ref = TerminalRefSchema.parse(refInput);
      const timeoutMs = z.number().int().min(0).max(TERMINAL_WAIT_MAX_MS).parse(input.timeoutMs ?? TERMINAL_WAIT_DEFAULT_MS);
      const output = input.output === undefined ? undefined : z.string().min(1).max(TERMINAL_WAIT_OUTPUT_MAX_CHARS).parse(input.output);
      const seen = input.seen === undefined ? undefined : z.number().int().min(0).max(1_000_000).parse(input.seen);
      if (shutdownController.signal.aborted) return Promise.resolve({ reason: "shutdown" });
      const key = terminalRefKey(ref);
      const forTab = perTab.get(key) ?? 0;
      if (total >= MAX_WAITERS || forTab >= MAX_WAITERS_PER_TAB) return Promise.reject(new TerminalWaitCapacityError());
      total += 1;
      perTab.set(key, forTab + 1);
      return run(ref, {
        timeoutMs,
        ...(output ? { output } : {}),
        ...(output && seen !== undefined ? { seen } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      })
        .finally(() => {
          total -= 1;
          const left = (perTab.get(key) ?? 1) - 1;
          if (left <= 0) perTab.delete(key);
          else perTab.set(key, left);
        });
    },
    shutdown() {
      shutdownController.abort();
    },
  };
}
