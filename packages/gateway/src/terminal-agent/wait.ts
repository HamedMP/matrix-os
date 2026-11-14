import { setTimeout as delay } from "node:timers/promises";
import { TerminalRefSchema, type TerminalRef, type TerminalTab } from "@matrix-os/contracts";
import { z } from "zod/v4";
import type { TerminalAgentStatusSource } from "./status-source.js";
import { terminalRefKey } from "./status-source.js";
import { visibleTerminalText } from "./screen-text.js";
import { TerminalAgentVerbError, type TerminalAgentStatus, type TerminalAgentVerbRuntime } from "./verbs.js";

/** One HTTP wait stays below common proxy idle limits; callers wait again after a check-in. */
export const TERMINAL_WAIT_MAX_MS = 90_000;
export const TERMINAL_WAIT_DEFAULT_MS = 60_000;
export const TERMINAL_WAIT_OUTPUT_MAX_CHARS = 256;
const DEFAULT_POLL_MS = 500;
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
  runtime: Pick<TerminalAgentVerbRuntime, "listWorkspaces" | "getSnapshot">;
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

  async function screenText(ref: TerminalRef): Promise<string> {
    const snapshot = z.object({
      viewport: z.array(z.string()).max(200),
      scrollback: z.array(z.string()).max(100_000),
    }).safeParse(await options.runtime.getSnapshot(ref));
    // Match what the terminal shows: snapshot rows keep their colour codes.
    return snapshot.success ? [...snapshot.data.scrollback, ...snapshot.data.viewport].map(visibleTerminalText).join("\n") : "";
  }

  async function run(ref: TerminalRef, input: { output?: string; seen?: number; timeoutMs: number; signal?: AbortSignal }): Promise<TerminalWaitResult> {
    const deadline = now() + input.timeoutMs;
    // A follow-up request continues the caller's baseline, so text printed between
    // two check-ins still counts as new.
    const baseline = input.output ? input.seen ?? countOccurrences(await screenText(ref), input.output) : 0;
    const signal = input.signal ? AbortSignal.any([input.signal, shutdownController.signal]) : shutdownController.signal;
    let lastStatus: TerminalAgentStatus | undefined;
    for (;;) {
      if (shutdownController.signal.aborted) return { reason: "shutdown" };
      if (input.signal?.aborted) return { reason: "cancelled" };
      const tab = await findTab(ref);
      if (tab.status === "exited" || tab.status === "failed") return { reason: "exited", exitCode: tab.exitCode ?? null };
      if (input.output) {
        if (countOccurrences(await screenText(ref), input.output) > baseline) return { reason: "output" };
      } else {
        lastStatus = (await options.status.get(ref))?.status;
        if (lastStatus && lastStatus !== "working") return { reason: "stopped", status: lastStatus };
      }
      const remaining = deadline - now();
      if (remaining <= 0) {
        return { reason: "timeout", ...(lastStatus ? { status: lastStatus } : {}), ...(input.output ? { seen: baseline } : {}) };
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
