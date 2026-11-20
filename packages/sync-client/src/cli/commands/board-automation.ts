import { BoardDurationSchema } from "@matrix-os/contracts/message-board";
import { channelPath, isMessageId, printSuccess, requireText, usage, type BoardVerb } from "../board-cli-support.js";
import { list } from "./board-format.js";

type Json = Record<string, unknown>;

function duration(value: unknown, flag: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !BoardDurationSchema.safeParse(value).success) usage(`${flag} takes a duration such as 30s, 5m, 2h or 7d`);
  return value as string;
}

function isoTime(value: unknown, flag: string): string | undefined {
  if (value === undefined) return undefined;
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (Number.isNaN(parsed)) usage(`${flag} takes a time such as 2026-12-01T09:00:00Z`);
  return new Date(parsed).toISOString();
}

function scheduleLine(item: Json): string {
  const target = (item.target ?? {}) as Json;
  const where = target.kind === "thread" ? `thread ${String(target.threadId)}` : `#${String(target.channel)}`;
  return `${String(item.id)} ${where} next ${String(item.nextRunAt)}${item.every ? ` every ${String(item.every)}` : ""}: ${String(item.text ?? "").split("\n")[0]}`;
}

/** `matrix board schedule <channel|id> "<text>" [--in|--at] [--every] [--times] [--until]` and `schedule cancel <id>`. */
const schedule: BoardVerb = {
  options: { in: { type: "string" }, at: { type: "string" }, every: { type: "string" }, times: { type: "string" }, until: { type: "string" } },
  prepare([target, ...words], values) {
    if (target === "cancel") {
      const id = words[0];
      if (!id || !/^sch_[A-Za-z0-9]{8,40}$/.test(id)) usage("Usage: matrix board schedule cancel <schedule id>");
      return async (ctx) => {
        await ctx.client.request("DELETE", `/schedules/${id}`, { body: {} });
        printSuccess(ctx.deps.io, ctx.json, { canceled: id }, `Canceled ${id!}`);
      };
    }
    const times = values.times === undefined ? undefined : Number(values.times);
    if (times !== undefined && (!Number.isInteger(times) || times < 1 || times > 10_000)) usage("--times takes a whole number from 1 to 10000");
    const body = {
      ...(isMessageId(target) ? { thread: target } : { channel: channelPath(target) }),
      text: requireText(words),
      ...(duration(values.in, "--in") ? { in: values.in } : {}),
      ...(isoTime(values.at, "--at") ? { at: isoTime(values.at, "--at") } : {}),
      ...(duration(values.every, "--every") ? { every: values.every } : {}),
      ...(times ? { times } : {}),
      ...(isoTime(values.until, "--until") ? { until: isoTime(values.until, "--until") } : {}),
    };
    return async (ctx) => {
      const { schedule: created } = await ctx.client.request("POST", "/schedules", { body: { ...body, ...(ctx.profile ? { profile: ctx.profile } : {}) } });
      printSuccess(ctx.deps.io, ctx.json, { schedule: created }, `Scheduled ${scheduleLine(created as Json)}`);
    };
  },
};

const schedules: BoardVerb = {
  prepare: () => async (ctx) => {
    const payload = await ctx.client.request("GET", "/schedules");
    printSuccess(ctx.deps.io, ctx.json, { schedules: payload.schedules }, list(payload.schedules).map(scheduleLine).join("\n") || "No schedules.");
  },
};

/** `matrix board channels` lists; `channels create <path> [--private]` creates one. */
const channels: BoardVerb = {
  options: { private: { type: "boolean" } },
  prepare([sub, path], values) {
    if (sub === "create") {
      const body = { path: channelPath(path), ...(values.private === true ? { private: true } : {}) };
      return async (ctx) => {
        await ctx.client.request("POST", "/channels", { body });
        printSuccess(ctx.deps.io, ctx.json, { channel: body }, `Created #${body.path}${body.private ? " (private)" : ""}`);
      };
    }
    if (sub !== undefined) usage("Usage: matrix board channels [create <path> [--private]]");
    return async (ctx) => {
      const payload = await ctx.client.request("GET", "/channels");
      const line = (c: Json) => `${String(c.path)} ${String(c.threadCount ?? 0)} threads${c.unread ? `, ${String(c.unread)} unread` : ""}`;
      printSuccess(ctx.deps.io, ctx.json, { channels: payload.channels }, list(payload.channels).map(line).join("\n") || "No channels.");
    };
  },
};

/** `matrix board grants explain <channel> [--user <actor>]`. */
const grants: BoardVerb = {
  options: { user: { type: "string" } },
  prepare([sub, channel], values) {
    if (sub !== "explain") usage("Usage: matrix board grants explain <channel> [--user user:<id>]");
    const query = { channel: channelPath(channel), ...(typeof values.user === "string" ? { principal: values.user } : {}) };
    return async (ctx) => {
      const { explanation } = await ctx.client.request("GET", "/grants/explain", { query });
      const value = explanation as Json;
      const permissions = Array.isArray(value.permissions) ? value.permissions.join(" ") : "";
      printSuccess(ctx.deps.io, ctx.json, { explanation }, `${String(value.principal)} on #${query.channel}: ${permissions || "no access"} (${String(value.source)}${value.pattern ? `, ${String(value.pattern)}` : ""})`);
    };
  },
};

export const BOARD_AUTOMATION_VERBS: Record<string, BoardVerb> = { schedule, schedules, channels, grants };
