import { defineCommand } from "citty";
import { EmojiSchema, IdempotencyKeySchema } from "@matrix-os/contracts/message-board";
import {
  BoardUsageError, channelPath, channelScope, defaultBoardDeps, EXIT_USAGE, isMessageId, labelKeys, labelPairs, messageId, openBoardContext, parseVerbArgs, printSuccess,
  reportFailure, requireText, strings, usage, type BoardDeps, type BoardVerb,
} from "../board-cli-support.js";
import { BOARD_EVENT_VERBS } from "./board-events.js";
import { formatMessage, formatThread, formatThreadSummary, list } from "./board-format.js";
import { BOARD_TASK_VERBS } from "./board-tasks.js";

function limit(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[0-9]{1,3}$/.test(value) || Number(value) < 1 || Number(value) > 500) usage("--limit must be 1 to 500");
  return Number(value);
}

const post: BoardVerb = {
  options: { label: { type: "string", multiple: true }, "idempotency-key": { type: "string" } },
  prepare([channel, ...words], values) {
    const body = {
      channel: channelPath(channel),
      text: requireText(words),
      ...(labelPairs(strings(values.label)) ? { labels: labelPairs(strings(values.label)) } : {}),
      ...(typeof values["idempotency-key"] === "string" ? { idempotencyKey: values["idempotency-key"] } : {}),
    };
    if (body.idempotencyKey !== undefined && !IdempotencyKeySchema.safeParse(body.idempotencyKey).success) usage("--idempotency-key takes up to 128 letters, digits and _.:-");
    return async (ctx) => {
      const { message } = await ctx.client.request("POST", "/messages", { body: { ...body, ...(ctx.profile ? { profile: ctx.profile } : {}) } });
      printSuccess(ctx.deps.io, ctx.json, { message }, `Posted ${formatMessage(message)}`);
    };
  },
};

const reply: BoardVerb = {
  options: { label: { type: "string", multiple: true } },
  prepare([id, ...words], values) {
    const target = messageId(id);
    const text = requireText(words);
    const labels = labelPairs(strings(values.label));
    return async (ctx) => {
      // A reply must name its thread's channel; read it from the thread.
      const { thread } = await ctx.client.request("GET", `/threads/${target}`);
      const root = (thread as { root?: { channel?: unknown } } | undefined)?.root;
      if (typeof root?.channel !== "string") usage("That thread could not be read");
      const { message } = await ctx.client.request("POST", "/messages", {
        body: { channel: root!.channel, text, re: target, ...(labels ? { labels } : {}), ...(ctx.profile ? { profile: ctx.profile } : {}) },
      });
      printSuccess(ctx.deps.io, ctx.json, { message }, `Replied ${formatMessage(message)}`);
    };
  },
};

const read: BoardVerb = {
  options: { by: { type: "string" }, mentions: { type: "string" }, label: { type: "string" }, text: { type: "string" }, limit: { type: "string" } },
  prepare([target], values) {
    const filters = {
      ...(typeof values.by === "string" ? { by: values.by } : {}),
      ...(typeof values.label === "string" ? { label: values.label } : {}),
      ...(typeof values.text === "string" ? { text: values.text } : {}),
      ...(limit(values.limit) ? { limit: limit(values.limit) } : {}),
    };
    if (isMessageId(target)) {
      if (Object.keys(filters).length || values.mentions !== undefined) usage("Filters apply to a channel, not a thread ID");
      return async (ctx) => {
        const { thread } = await ctx.client.request("GET", `/threads/${target}`);
        printSuccess(ctx.deps.io, ctx.json, { thread }, formatThread(thread));
      };
    }
    const channel = channelScope(target);
    if (typeof values.mentions === "string") {
      return async (ctx) => {
        const { messages } = await ctx.client.request("GET", "/messages", { query: { ...(channel ? { channel } : {}), mentions: values.mentions as string, ...filters } });
        printSuccess(ctx.deps.io, ctx.json, { messages }, list(messages).map(formatMessage).join("\n") || "No messages.");
      };
    }
    return async (ctx) => {
      const { threads } = await ctx.client.request("GET", "/threads", { query: { ...(channel ? { channel } : {}), ...filters } });
      printSuccess(ctx.deps.io, ctx.json, { threads }, list(threads).map(formatThreadSummary).join("\n") || "No threads.");
    };
  },
};

const label: BoardVerb = {
  options: { unset: { type: "string", multiple: true }, if: { type: "string", multiple: true }, "if-unset": { type: "string", multiple: true } },
  prepare([id, ...pairs], values) {
    const target = messageId(id);
    const body = {
      ...(labelPairs(pairs, "label") ? { set: labelPairs(pairs, "label") } : {}),
      ...(labelKeys(strings(values.unset), "--unset") ? { unset: strings(values.unset) } : {}),
      ...(labelPairs(strings(values.if), "--if") ? { if: labelPairs(strings(values.if), "--if") } : {}),
      ...(labelKeys(strings(values["if-unset"]), "--if-unset") ? { ifUnset: strings(values["if-unset"]) } : {}),
    };
    if (!body.set && !body.unset) usage("Give key=value labels to set or --unset keys");
    return async (ctx) => {
      await ctx.client.request("PATCH", `/messages/${target}/labels`, { body });
      printSuccess(ctx.deps.io, ctx.json, { id: target, ...body }, "Labels updated.");
    };
  },
};

const react: BoardVerb = {
  options: { remove: { type: "boolean" } },
  prepare([id, emoji], values) {
    const target = messageId(id);
    if (!emoji || !EmojiSchema.safeParse(emoji).success) usage("An emoji or :name: is required");
    const on = values.remove !== true;
    return async (ctx) => {
      await ctx.client.request("POST", `/messages/${target}/reactions`, { body: { emoji, on } });
      printSuccess(ctx.deps.io, ctx.json, { id: target, emoji, on }, on ? "Reacted." : "Reaction removed.");
    };
  },
};

const edit: BoardVerb = {
  prepare([id, ...words]) {
    const target = messageId(id);
    const text = requireText(words);
    return async (ctx) => {
      const { message } = await ctx.client.request("PATCH", `/messages/${target}`, { body: { text } });
      printSuccess(ctx.deps.io, ctx.json, { message }, `Edited ${formatMessage(message)}`);
    };
  },
};

const remove: BoardVerb = {
  prepare([id]) {
    const target = messageId(id);
    return async (ctx) => {
      await ctx.client.request("DELETE", `/messages/${target}`, { body: {} });
      printSuccess(ctx.deps.io, ctx.json, { id: target, deleted: true }, "Deleted.");
    };
  },
};

function listing(path: string, key: string, line: (item: Record<string, unknown>) => string): BoardVerb {
  return {
    prepare: () => async (ctx) => {
      const payload = await ctx.client.request("GET", path);
      printSuccess(ctx.deps.io, ctx.json, { [key]: payload[key] }, list(payload[key]).map(line).join("\n") || `No ${key}.`);
    },
  };
}

const whoami: BoardVerb = {
  prepare: () => async (ctx) => {
    const { actor } = await ctx.client.request("GET", "/whoami");
    const a = (actor ?? {}) as Record<string, unknown>;
    printSuccess(ctx.deps.io, ctx.json, { actor }, `${String(a.id ?? "")} ${String(a.name ?? "")}${a.profile ? ` as ${String(a.profile)}` : ""}`.trim());
  },
};

const VERBS: Record<string, BoardVerb> = {
  post, reply, read, label, react, edit, delete: remove, whoami,
  channels: listing("/channels", "channels", (c) => `${String(c.path)} ${String(c.threadCount ?? 0)} threads${c.unread ? `, ${String(c.unread)} unread` : ""}`),
  actors: listing("/actors", "actors", (a) => `${String(a.id)} ${String(a.name ?? "")}`.trim()),
  boards: listing("/boards", "boards", (b) => `${String(b.name)} (${String(b.scope ?? "")})`),
  ...BOARD_EVENT_VERBS,
};

const USAGE = `matrix board <verb>: post, reply, read, tail, wait, label, react, edit, delete, channels, actors, whoami, boards,
  tasks list|create|claim|renew|release|complete|fail|block|unblock|reopen|assign|needs|cancel|run.
Global flags: --json, --board <name>, --as <profile>.`;

/** Runs `matrix board …` and returns its exit code (0 ok, 1 failure or timeout, 2 usage, 130 interrupt). */
export async function runBoardCli(argv: string[], overrides: Partial<BoardDeps> = {}): Promise<number> {
  const deps: BoardDeps = { ...defaultBoardDeps(), ...overrides };
  const json = argv.includes("--json");
  const [first, second] = argv;
  const isTasks = first === "tasks";
  const verb = isTasks ? (second ? BOARD_TASK_VERBS[second] : undefined) : first ? VERBS[first] : undefined;
  if (!verb) {
    if (json) return reportFailure(deps.io, true, new BoardUsageError("Unknown board verb"));
    deps.io.stderr(USAGE);
    return EXIT_USAGE;
  }
  const rest = argv.slice(isTasks ? 2 : 1);
  try {
    // `tasks run` passes everything after `--` to the command untouched.
    const split = verb.passthrough ? rest.indexOf("--") : -1;
    const own = split === -1 ? rest : rest.slice(0, split);
    const { positionals, values } = parseVerbArgs(own, verb.options ?? {});
    const action = verb.prepare(split === -1 ? positionals : [...positionals, "--", ...rest.slice(split + 1)], values);
    const ctx = await openBoardContext(deps, values);
    return (await action(ctx)) ?? 0;
  } catch (error: unknown) {
    return reportFailure(deps.io, json, error);
  }
}

export const boardCommand = defineCommand({
  meta: { name: "board", description: "Agent message board: post, read, wait on and work through board tasks" },
  async run({ rawArgs }) {
    process.exitCode = await runBoardCli(rawArgs);
  },
});
