import { lstat, readFile } from "node:fs/promises";
import {
  BOARD_DEFAULT_NAME, BoardTaskKindSchema, BoardTaskStateSchema, CreateTaskPlanRequestSchema,
} from "@matrix-os/contracts/message-board";
import {
  BoardUsageError, channelPath, channelScope, labelPairs, leaseSeconds, messageId, optionalDuration, printSuccess, profileName,
  requireText, strings, usage, type BoardContext, type BoardVerb, type ParsedValues,
} from "../board-cli-support.js";
import { formatThreadSummary, list } from "./board-format.js";
import { BOARD_RUN_VERB } from "./board-run.js";
import { acquireClaim, claimTarget, labelFilter, rememberClaim, taskVerb, type HeldClaim } from "./board-task-actions.js";

const PLAN_FILE_MAX_BYTES = 256 * 1024;

function claimText(claim: HeldClaim): string {
  const until = typeof claim.task.leaseUntil === "string" ? `, lease until ${claim.task.leaseUntil}` : "";
  return `Claimed ${claim.taskId} (epoch ${claim.epoch}${until}).\nSettle with: matrix board tasks complete ${claim.taskId} "result"`;
}

const claimOptions = {
  ready: { type: "string" }, label: { type: "string" }, from: { type: "string" }, wait: { type: "string" }, lease: { type: "string" },
} as const;

const claim: BoardVerb = {
  options: claimOptions,
  prepare([id], values) {
    const target = claimTarget(id, values);
    const lease = leaseSeconds(values.lease);
    const waitMs = optionalDuration(values.wait, "--wait");
    return async (ctx) => {
      const held = await acquireClaim(ctx, target, { ...(lease ? { leaseSeconds: lease } : {}), ...(waitMs !== undefined ? { waitMs } : {}) });
      const { board, leaseSeconds: _lease, ...shown } = held;
      printSuccess(ctx.deps.io, ctx.json, { claim: shown, board }, claimText(held));
    };
  },
};

const listTasks: BoardVerb = {
  options: { state: { type: "string" }, label: { type: "string" }, limit: { type: "string" } },
  prepare([channel], values) {
    const state = values.state;
    if (state !== undefined && !BoardTaskStateSchema.safeParse(state).success) usage("--state must be waiting, ready, claimed, blocked, completed, failed or canceled");
    const limit = values.limit;
    if (limit !== undefined && (typeof limit !== "string" || !/^[0-9]{1,3}$/.test(limit) || Number(limit) < 1 || Number(limit) > 500)) usage("--limit must be 1 to 500");
    const label = labelFilter(values.label);
    const scope = channelScope(channel);
    return async (ctx) => {
      const { tasks } = await ctx.client.request("GET", "/tasks", {
        query: { ...(scope ? { channel: scope } : {}), ...(typeof state === "string" ? { state } : {}), ...(label ? { label } : {}), ...(typeof limit === "string" ? { limit } : {}) },
      });
      printSuccess(ctx.deps.io, ctx.json, { tasks }, list(tasks).map(formatThreadSummary).join("\n") || "No tasks.");
    };
  },
};

async function readPlan(path: string): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.size > PLAN_FILE_MAX_BYTES) usage("--plan must be a JSON file of at most 256 KiB");
    raw = await readFile(path, "utf8");
  } catch (error: unknown) {
    if (error instanceof BoardUsageError) throw error;
    const code = (error as { code?: unknown } | null)?.code;
    if (code === "ENOENT" || code === "EACCES" || code === "EISDIR") usage("--plan file could not be read");
    throw error;
  }
  try {
    const parsed: unknown = JSON.parse(raw!);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) usage("--plan must hold a JSON object");
    return parsed as Record<string, unknown>;
  } catch (error: unknown) {
    if (error instanceof SyntaxError) usage("--plan is not valid JSON");
    throw error;
  }
}

const create: BoardVerb = {
  options: {
    plan: { type: "string" }, needs: { type: "string", multiple: true }, for: { type: "string" }, claim: { type: "boolean" },
    label: { type: "string", multiple: true },
  },
  prepare([channel, ...words], values) {
    if (typeof values.plan === "string") {
      if (channel !== undefined) usage("--plan takes the channel from the file");
      const file = values.plan;
      return async (ctx) => {
        const plan = { ...(await readPlan(file)), ...(ctx.profile ? { profile: ctx.profile } : {}) };
        if (!CreateTaskPlanRequestSchema.safeParse(plan).success) usage("--plan must be {channel, tasks:[{key, text, needs?, labels?, forProfile?}]} with 1 to 15 tasks");
        const { tasks } = await ctx.client.request("POST", "/tasks", { body: plan });
        printSuccess(ctx.deps.io, ctx.json, { tasks }, `Created ${list(tasks).length} tasks.`);
      };
    }
    const needs = strings(values.needs).map((id) => messageId(id, "--needs task ID"));
    const forProfile = profileName(values.for, "--for");
    const labels = labelPairs(strings(values.label));
    const body = {
      channel: channelPath(channel), text: requireText(words),
      ...(labels ? { labels } : {}), ...(needs.length ? { needs } : {}), ...(forProfile ? { forProfile } : {}),
      ...(values.claim === true ? { claim: true } : {}),
    };
    return async (ctx) => {
      const payload = await ctx.client.request("POST", "/tasks", { body: { ...body, ...(ctx.profile ? { profile: ctx.profile } : {}) } });
      const root = payload.root as { id?: unknown } | undefined;
      let text = `Created task ${String(root?.id ?? "")}.`;
      if (payload.claim) {
        const claimed = payload.claim as HeldClaim;
        await rememberClaim(ctx, { ...claimed, board: ctx.board ?? BOARD_DEFAULT_NAME });
        text = `${text}\n${claimText({ ...claimed, task: claimed.task ?? {}, board: ctx.board ?? BOARD_DEFAULT_NAME })}`;
      }
      printSuccess(ctx.deps.io, ctx.json, payload, text);
    };
  },
};

type Shape = (positionals: string[], values: ParsedValues) => (stored: Parameters<Parameters<typeof taskVerb>[3]>[0]) => Record<string, unknown>;

function verb(name: string, done: string, shape: Shape, options: { proof?: boolean; forget?: boolean; flags?: BoardVerb["options"] } = {}): BoardVerb {
  return {
    ...(options.flags ? { options: options.flags } : {}),
    prepare([id, ...rest], values) {
      const taskId = messageId(id, "task ID");
      const body = shape(rest, values);
      return async (ctx: BoardContext) => {
        const payload = await taskVerb(ctx, name, taskId, body, { ...(options.proof ? { proof: true } : {}), ...(options.forget ? { forget: true } : {}) });
        printSuccess(ctx.deps.io, ctx.json, { id: taskId, ...payload }, `${done} ${taskId}.`);
      };
    },
  };
}

const reason = (what: string): Shape => (words) => {
  const text = requireText(words, what);
  if (text.trim().length > 2_000) usage(`${what} must be at most 2000 characters`);
  return () => ({ reason: text.trim() });
};
const none: Shape = (words) => {
  if (words.length) usage("Unexpected arguments");
  return () => ({});
};

export const BOARD_TASK_VERBS: Record<string, BoardVerb> = {
  list: listTasks,
  create,
  claim,
  renew: verb("renew", "Renewed", (words, values) => {
    if (words.length) usage("Unexpected arguments");
    const lease = leaseSeconds(values.lease);
    return (stored) => {
      const seconds = lease ?? stored?.leaseSeconds;
      return seconds ? { leaseSeconds: seconds } : {};
    };
  }, { proof: true, flags: { lease: { type: "string" } } }),
  release: verb("release", "Released", none, { proof: true, forget: true }),
  complete: verb("complete", "Completed", (words) => {
    const result = words.join(" ").trim();
    return () => (result ? { result } : {});
  }, { proof: true, forget: true }),
  fail: verb("fail", "Failed", reason("A reason"), { proof: true, forget: true }),
  block: verb("block", "Blocked", (words, values) => {
    const body = reason("A reason")(words, values);
    const kind = values.kind;
    if (kind !== undefined && !BoardTaskKindSchema.safeParse(kind).success) usage("--kind takes a word like needs_input");
    return (stored) => ({ ...body(stored), ...(typeof kind === "string" ? { kind } : {}) });
  }, { proof: true, forget: true, flags: { kind: { type: "string" } } }),
  unblock: verb("unblock", "Unblocked", none),
  reopen: verb("reopen", "Reopened", none),
  assign: verb("assign", "Assigned", ([profile, ...extra], values) => {
    if (extra.length) usage("Unexpected arguments");
    if (values.pool === true) {
      if (profile !== undefined) usage("Give a profile or --pool, not both");
      return () => ({ profile: null });
    }
    if (profile === undefined) usage("Give a profile or --pool");
    const name = profileName(profile, "profile");
    return () => ({ profile: name });
  }, { flags: { pool: { type: "boolean" } } }),
  needs: verb("needs", "Updated prerequisites of", (ids) => {
    const needs = ids.map((id) => messageId(id, "prerequisite task ID"));
    return () => ({ needs });
  }),
  cancel: verb("cancel", "Canceled", reason("A reason"), { forget: true }),
  run: BOARD_RUN_VERB,
};
