import { BOARD_DEFAULT_NAME, BOARD_WAIT_MAX_SECONDS, BoardActorIdSchema, LabelFilterSchema } from "@matrix-os/contracts/message-board";
import type { StoredClaim } from "../board-claims.js";
import { BoardCliError, boardClientError } from "../board-client.js";
import { channelScope, messageId, usage, type BoardContext, type ParsedValues } from "../board-cli-support.js";

export interface HeldClaim { taskId: string; epoch: number; token: string; task: Record<string, unknown>; board: string; leaseSeconds?: number }

export type ClaimTarget = { id: string } | { ready: string; label?: string; from?: string };

export function labelFilter(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !LabelFilterSchema.safeParse(value).success) usage("--label takes k, k=v or k=v|w");
  return value as string;
}

/** `--ready <scope> [--label] [--from]`, or a task ID. */
export function claimTarget(id: string | undefined, values: ParsedValues): ClaimTarget {
  if (typeof values.ready === "string") {
    if (id !== undefined) usage("Give a task ID or --ready <channel>, not both");
    const from = values.from;
    if (from !== undefined && (typeof from !== "string" || !BoardActorIdSchema.safeParse(from).success)) usage("--from takes an actor ID like agent:… or user:…");
    const label = labelFilter(values.label);
    return { ready: channelScope(values.ready)!, ...(label ? { label } : {}), ...(typeof from === "string" ? { from } : {}) };
  }
  return { id: messageId(id, "task ID or --ready <channel>") };
}


/** Reasons after which a remembered claim proves nothing any more. */
const DEAD_CLAIM = new Set(["claim_lost", "claim_not_held", "task_finished"]);
const POLL_SLACK_MS = 10_000;

function heldClaim(payload: Record<string, unknown>, board: string, leaseSeconds?: number): HeldClaim {
  const claim = payload.claim as Record<string, unknown> | undefined;
  if (!claim || typeof claim.taskId !== "string" || typeof claim.epoch !== "number" || typeof claim.token !== "string") {
    throw boardClientError("invalid_response");
  }
  const task = claim.task && typeof claim.task === "object" ? claim.task as Record<string, unknown> : {};
  return { taskId: claim.taskId, epoch: claim.epoch, token: claim.token, task, board, ...(leaseSeconds ? { leaseSeconds } : {}) };
}

/** Remembers a claim so settle verbs need only the task ID. */
export async function rememberClaim(ctx: BoardContext, claim: HeldClaim): Promise<void> {
  const stored: StoredClaim = {
    taskId: claim.taskId, epoch: claim.epoch, token: claim.token, board: claim.board,
    claimedAt: new Date(ctx.deps.now()).toISOString(), ...(claim.leaseSeconds ? { leaseSeconds: claim.leaseSeconds } : {}),
  };
  await ctx.claims.save(stored);
}

/** Claims one task, waiting client-side in 25 s server waits when `waitMs` is longer. */
export async function acquireClaim(
  ctx: BoardContext,
  target: ClaimTarget,
  options: { leaseSeconds?: number; waitMs?: number; signal?: AbortSignal } = {},
): Promise<HeldClaim> {
  const board = ctx.board ?? BOARD_DEFAULT_NAME;
  const base = {
    ...target,
    ...(options.leaseSeconds ? { leaseSeconds: options.leaseSeconds } : {}),
    ...(ctx.profile ? { profile: ctx.profile } : {}),
  };
  const deadline = ctx.deps.now() + (options.waitMs ?? 0);
  for (;;) {
    const waitSeconds = "ready" in target && options.waitMs !== undefined
      ? Math.min(BOARD_WAIT_MAX_SECONDS, Math.ceil(Math.max(0, deadline - ctx.deps.now()) / 1000))
      : undefined;
    try {
      const payload = await ctx.client.request("POST", "/tasks/claim", {
        body: { ...base, ...(waitSeconds !== undefined ? { waitSeconds } : {}) },
        timeoutMs: (waitSeconds ?? 0) * 1000 + POLL_SLACK_MS,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      const claim = heldClaim(payload, board, options.leaseSeconds);
      await rememberClaim(ctx, claim);
      return claim;
    } catch (error: unknown) {
      const again = error instanceof BoardCliError && error.reason === "nothing_ready" && deadline - ctx.deps.now() > 0;
      if (!again) throw error;
    }
  }
}

/**
 * Posts a task verb. Holder verbs (`proof`) send the remembered epoch and token,
 * on the board the claim was made on unless `--board` says otherwise.
 */
export async function taskVerb(
  ctx: BoardContext,
  verb: string,
  taskId: string,
  body: (stored: StoredClaim | null) => Record<string, unknown>,
  options: { proof?: boolean; forget?: boolean; signal?: AbortSignal } = {},
): Promise<Record<string, unknown>> {
  const stored = options.proof ? await ctx.claims.load(taskId) : null;
  const client = stored && !ctx.board ? ctx.clientFor(stored.board) : ctx.client;
  try {
    const payload = await client.request("POST", `/tasks/${taskId}/${verb}`, {
      body: { ...(stored ? { epoch: stored.epoch, token: stored.token } : {}), ...body(stored) },
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (options.forget) await ctx.claims.forget(taskId);
    return payload;
  } catch (error: unknown) {
    if (error instanceof BoardCliError && DEAD_CLAIM.has(error.reason)) await ctx.claims.forget(taskId);
    throw error;
  }
}
