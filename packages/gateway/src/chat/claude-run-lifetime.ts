import type { CanonicalCliLifetimeOptions } from "./cli-process.js";

/** Busy owner turns have no session-idle or whole-run deadline. */
export function claudeCliLifetime(input: {
  idleTimeoutMs?: number;
  fundedRunTimeoutMs?: number;
}): CanonicalCliLifetimeOptions {
  return {
    startupTimeoutMs: 30_000,
    ...(input.fundedRunTimeoutMs === undefined ? {} : { timeoutMs: input.fundedRunTimeoutMs }),
    ...(input.idleTimeoutMs === undefined ? {} : {
      idleTimeoutMs: Math.min(input.idleTimeoutMs, input.fundedRunTimeoutMs ?? input.idleTimeoutMs),
    }),
  };
}
