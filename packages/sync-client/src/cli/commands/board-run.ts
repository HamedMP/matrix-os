import { spawn } from "node:child_process";
import { BOARD_LEASE_DEFAULT_SECONDS } from "@matrix-os/contracts/message-board";
import { BoardCliError } from "../board-client.js";
import {
  EXIT_OK, interruptSignal, leaseSeconds, optionalDuration, printSuccess, usage, type BoardChild, type BoardContext,
  type BoardSpawnOptions, type BoardVerb,
} from "../board-cli-support.js";
import { acquireClaim, claimTarget, taskVerb, type ClaimProof, type HeldClaim } from "./board-task-actions.js";

const LOST = new Set(["claim_lost", "claim_not_held", "task_finished"]);
/** How long a stopped command gets after SIGTERM before its process group is killed. */
const STOP_GRACE_MS = 5_000;
/** Stop this long before the last confirmed lease ends, so the work never outlives it. */
const LEASE_MARGIN_MS = 5_000;

type Exit = { code: number | null; signal: NodeJS.Signals | null } | { error: Error };
type Stop = "interrupted" | "lost" | "lease_expired";

function reasonOf(error: unknown): string {
  return error instanceof BoardCliError ? error.reason : "request_failed";
}

function exitFacts(result: Exit | null): { exitCode: number | null; signal?: string } {
  if (!result || "error" in result) return { exitCode: null };
  return { exitCode: result.code, ...(result.signal ? { signal: result.signal } : {}) };
}

/**
 * Runs the command for a held claim in its own process group. Renews at a third of
 * the lease using the claim held in memory (never the shared claim file), stops the
 * group before the last confirmed lease runs out, settles on exit, and releases on
 * interrupt. Under --json stdout carries exactly one document, printed after settling.
 */
async function runHeld(ctx: BoardContext, held: HeldClaim, command: string[], interrupt: AbortSignal): Promise<number> {
  const { taskId } = held;
  const proof: ClaimProof = { epoch: held.epoch, token: held.token, board: held.board, ...(held.leaseSeconds ? { leaseSeconds: held.leaseSeconds } : {}) };
  const leaseMs = (held.leaseSeconds ?? BOARD_LEASE_DEFAULT_SECONDS) * 1000;
  const now = ctx.deps.now;
  const kill = ctx.deps.kill ?? ((pid: number, signal: NodeJS.Signals) => void process.kill(pid, signal));
  const spawnImpl = ctx.deps.spawn ?? ((file: string, args: string[], options: BoardSpawnOptions) => spawn(file, args, options) as BoardChild);

  let leaseEnds = now() + leaseMs;
  ctx.deps.io.stderr(`Claimed ${taskId}; running ${command[0]}.`);
  const child = spawnImpl(command[0]!, command.slice(1), {
    env: { ...ctx.deps.env, BOARD_TASK: taskId },
    stdio: ctx.json ? ["inherit", 2, "inherit"] : "inherit",
    detached: true,
  });
  let hasExited = false;
  const exited = new Promise<Exit>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
    child.once("error", (error) => resolve({ error }));
  }).then((result) => {
    hasExited = true;
    return result;
  });

  const signalGroup = (signal: NodeJS.Signals) => {
    if (hasExited) return;
    if (!child.pid) {
      child.kill(signal);
      return;
    }
    try {
      kill(-child.pid, signal);
    } catch (error: unknown) {
      if ((error as { code?: unknown } | null)?.code === "ESRCH") return;
      console.warn("[matrix] could not signal the command's process group:", error instanceof Error ? error.name : "UnknownError");
      child.kill(signal);
    }
  };

  let stopped: Stop | null = null;
  let lostError: unknown;
  let renewing = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const stop = (why: Stop) => {
    if (stopped) return;
    stopped = why;
    clearInterval(timer);
    clearTimeout(deadline);
    signalGroup("SIGTERM");
    killTimer = setTimeout(() => signalGroup("SIGKILL"), STOP_GRACE_MS);
  };
  const armDeadline = () => {
    clearTimeout(deadline);
    deadline = setTimeout(() => stop("lease_expired"), Math.max(0, leaseEnds - LEASE_MARGIN_MS - now()));
  };
  const renew = async () => {
    if (renewing || stopped) return;
    renewing = true;
    const sentAt = now();
    try {
      await taskVerb(ctx, "renew", taskId, () => (held.leaseSeconds ? { leaseSeconds: held.leaseSeconds } : {}), { proof });
      // A reply that lands after the command exited must not start a new deadline timer.
      if (!stopped && !hasExited) {
        leaseEnds = sentAt + leaseMs;
        armDeadline();
      }
    } catch (error: unknown) {
      if (LOST.has(reasonOf(error))) {
        lostError = error;
        stop("lost");
      } else {
        ctx.deps.io.stderr(`warning: could not renew ${taskId} (${reasonOf(error)}); the command stops before the lease ends unless a renew succeeds.`);
      }
    } finally {
      renewing = false;
    }
  };
  const timer = setInterval(() => void renew(), Math.max(1_000, Math.floor(leaseMs / 3)));
  armDeadline();
  const onInterrupt = () => stop("interrupted");
  if (interrupt.aborted) onInterrupt();
  else interrupt.addEventListener("abort", onInterrupt, { once: true });

  let result: Exit | null = null;
  try {
    result = await exited;
  } finally {
    clearInterval(timer);
    clearTimeout(deadline);
    clearTimeout(killTimer);
    interrupt.removeEventListener("abort", onInterrupt);
  }

  const facts = (outcome: string) => ({ taskId, outcome, ...exitFacts(result) });
  const finalStop = stopped as Stop | null;
  if (finalStop === "interrupted") {
    try {
      await taskVerb(ctx, "release", taskId, () => ({}), { proof });
    } catch (error: unknown) {
      ctx.deps.io.stderr(`warning: could not release ${taskId} (${reasonOf(error)}); its lease will lapse.`);
    }
    throw new BoardCliError("interrupted", "Interrupted; the task was released.", { extra: facts("released") });
  }
  if (finalStop === "lost") {
    const lost = lostError instanceof BoardCliError ? lostError : new BoardCliError("claim_lost", "Your claim on this task has lapsed.");
    throw new BoardCliError(lost.reason, lost.message, { ...(lost.next ? { next: lost.next } : {}), extra: facts("claim_lost") });
  }
  if (finalStop === "lease_expired") {
    throw new BoardCliError("lease_expired", "The lease could not be renewed in time, so the command was stopped.", {
      next: `read the task with matrix board read ${taskId}; claim it again if it is ready`, extra: facts("lease_expired"),
    });
  }
  if ("error" in result!) {
    await taskVerb(ctx, "fail", taskId, () => ({ reason: "command could not start" }), { proof });
    throw new BoardCliError("command_failed", "The command could not start; the task was failed.", { extra: facts("failed") });
  }
  if (result!.code === 0) {
    await taskVerb(ctx, "complete", taskId, () => ({}), { proof });
    printSuccess(ctx.deps.io, ctx.json, facts("completed"), `Completed ${taskId}.`);
    return EXIT_OK;
  }
  const reason = result!.code === null ? `signal ${result!.signal ?? "unknown"}` : `exit ${result!.code}`;
  await taskVerb(ctx, "fail", taskId, () => ({ reason }), { proof });
  throw new BoardCliError("command_failed", `The command ended with ${reason}; the task was failed.`, { extra: facts("failed") });
}

/** `tasks run --ready <channel> [--label] [--from] [--wait] [--lease] -- <command…>` */
export const BOARD_RUN_VERB: BoardVerb = {
  passthrough: true,
  options: { ready: { type: "string" }, label: { type: "string" }, from: { type: "string" }, wait: { type: "string" }, lease: { type: "string" } },
  prepare(positionals, values) {
    const separator = positionals.indexOf("--");
    const own = separator === -1 ? positionals : positionals.slice(0, separator);
    const command = separator === -1 ? [] : positionals.slice(separator + 1);
    if (typeof values.ready !== "string" || own.length) usage("tasks run takes --ready <channel>, then -- and the command");
    if (command.length === 0) usage("Give the command to run after --");
    const target = claimTarget(undefined, values);
    const lease = leaseSeconds(values.lease);
    const waitMs = optionalDuration(values.wait, "--wait");
    return async (ctx) => {
      const interrupt = interruptSignal(ctx.deps.signals);
      try {
        // The claim stays in memory: a shared claim file could be settled or replaced by another pane.
        const held = await acquireClaim(ctx, target, {
          ...(lease ? { leaseSeconds: lease } : {}), ...(waitMs !== undefined ? { waitMs } : {}), signal: interrupt.signal, remember: false,
        });
        return await runHeld(ctx, held, command, interrupt.signal);
      } finally {
        interrupt.dispose();
      }
    };
  },
};
