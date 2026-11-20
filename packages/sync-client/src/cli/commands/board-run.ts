import { spawn } from "node:child_process";
import { BOARD_LEASE_DEFAULT_SECONDS } from "@matrix-os/contracts/message-board";
import { BoardCliError, boardClientError } from "../board-client.js";
import {
  EXIT_FAILURE, interruptSignal, leaseSeconds, optionalDuration, usage, type BoardChild, type BoardContext, type BoardVerb,
} from "../board-cli-support.js";
import { acquireClaim, claimTarget, taskVerb, type HeldClaim } from "./board-task-actions.js";

const LOST = new Set(["claim_lost", "claim_not_held", "task_finished"]);

type Exit = { code: number | null; signal: NodeJS.Signals | null } | { error: Error };

function reasonOf(error: unknown): string {
  return error instanceof BoardCliError ? error.reason : "request_failed";
}

/** Runs the command for a held claim: renews at a third of the lease, settles on exit, releases on interrupt. */
async function runHeld(ctx: BoardContext, held: HeldClaim, command: string[], interrupt: AbortSignal): Promise<number> {
  const { taskId } = held;
  const leaseMs = (held.leaseSeconds ?? BOARD_LEASE_DEFAULT_SECONDS) * 1000;
  const spawnImpl = ctx.deps.spawn ?? ((file, args, options) => spawn(file, args, options) as BoardChild);
  ctx.deps.io.stderr(`Claimed ${taskId}; running ${command[0]}.`);
  const child = spawnImpl(command[0]!, command.slice(1), { env: { ...ctx.deps.env, BOARD_TASK: taskId }, stdio: "inherit" });
  const exited = new Promise<Exit>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
    child.once("error", (error) => resolve({ error }));
  });

  let stopped: "interrupted" | "lost" | null = null;
  let lostError: unknown;
  let renewing = false;
  const stop = (why: "interrupted" | "lost", signal: NodeJS.Signals) => {
    if (stopped) return;
    stopped = why;
    clearInterval(timer);
    child.kill(signal);
  };
  const renew = async () => {
    if (renewing || stopped) return;
    renewing = true;
    try {
      await taskVerb(ctx, "renew", taskId, () => (held.leaseSeconds ? { leaseSeconds: held.leaseSeconds } : {}), { proof: true });
    } catch (error: unknown) {
      if (LOST.has(reasonOf(error))) {
        lostError = error;
        stop("lost", "SIGTERM");
      } else {
        ctx.deps.io.stderr(`warning: could not renew ${taskId} (${reasonOf(error)}); retrying at the next interval.`);
      }
    } finally {
      renewing = false;
    }
  };
  const timer = setInterval(() => void renew(), Math.max(1_000, Math.floor(leaseMs / 3)));
  const onInterrupt = () => stop("interrupted", "SIGINT");
  if (interrupt.aborted) onInterrupt();
  else interrupt.addEventListener("abort", onInterrupt, { once: true });

  try {
    const result = await exited;
    if (stopped === "interrupted") {
      try {
        await taskVerb(ctx, "release", taskId, () => ({}), { proof: true, forget: true });
      } catch (error: unknown) {
        ctx.deps.io.stderr(`warning: could not release ${taskId} (${reasonOf(error)}); its lease will lapse.`);
      }
      throw boardClientError("interrupted");
    }
    if (stopped === "lost") throw lostError;
    if ("error" in result) {
      await taskVerb(ctx, "fail", taskId, () => ({ reason: "command could not start" }), { proof: true, forget: true });
      ctx.deps.io.stderr(`Failed ${taskId}: the command could not start.`);
      return EXIT_FAILURE;
    }
    if (result.code === 0) {
      await taskVerb(ctx, "complete", taskId, () => ({}), { proof: true, forget: true });
      ctx.deps.io.stderr(`Completed ${taskId}.`);
      return 0;
    }
    const reason = result.code === null ? `signal ${result.signal ?? "unknown"}` : `exit ${result.code}`;
    await taskVerb(ctx, "fail", taskId, () => ({ reason }), { proof: true, forget: true });
    ctx.deps.io.stderr(`Failed ${taskId}: ${reason}.`);
    return EXIT_FAILURE;
  } finally {
    clearInterval(timer);
    interrupt.removeEventListener("abort", onInterrupt);
  }
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
        const held = await acquireClaim(ctx, target, {
          ...(lease ? { leaseSeconds: lease } : {}), ...(waitMs !== undefined ? { waitMs } : {}), signal: interrupt.signal,
        });
        return await runHeld(ctx, held, command, interrupt.signal);
      } finally {
        interrupt.dispose();
      }
    };
  },
};
