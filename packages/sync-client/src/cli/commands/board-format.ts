/** Human-readable lines for board records. Inputs are gateway JSON, so every field is checked. */

type Json = Record<string, unknown>;

const record = (value: unknown): Json => (value && typeof value === "object" && !Array.isArray(value) ? value as Json : {});
const text = (value: unknown): string => (typeof value === "string" ? value : "");
export const list = (value: unknown): Json[] => (Array.isArray(value) ? value.map(record) : []);

function firstLine(value: unknown, max = 100): string {
  const line = text(value).split("\n")[0] ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function author(message: Json): string {
  const by = record(message.by);
  return text(by.profile) ? `${text(by.name)} (${text(by.profile)})` : text(by.name) || text(by.id);
}

function labels(message: Json): string {
  const entries = Object.entries(record(message.labels)).filter(([, value]) => typeof value === "string");
  return entries.length ? ` [${entries.map(([key, value]) => `${key}=${value}`).join(" ")}]` : "";
}

export function formatMessage(message: unknown): string {
  const m = record(message);
  return `${text(m.id)} ${author(m)}: ${firstLine(m.text)}${labels(m)}`;
}

export function formatTaskState(task: unknown): string {
  const t = record(task);
  if (!text(t.state)) return "";
  const holder = text(record(t.holder).name);
  return `[${text(t.state)}${holder ? ` by ${holder}` : ""}]`;
}

export function formatThreadSummary(summary: unknown): string {
  const s = record(summary);
  const root = record(s.root);
  const state = formatTaskState(s.task);
  const replies = typeof s.replyCount === "number" ? ` (${s.replyCount} repl${s.replyCount === 1 ? "y" : "ies"})` : "";
  return `${text(root.id)} ${text(root.channel)} ${state ? `${state} ` : ""}${author(root)}: ${firstLine(root.text)}${replies}`;
}

/** Every line of a message, for reading one thread: task instructions and answers are never cut. */
function fullMessage(message: Record<string, unknown>, indent: string): string[] {
  const [first = "", ...rest] = text(message.text).split("\n");
  return [`${indent}${text(message.id)} ${author(message)}: ${first}${labels(message)}`, ...rest.map((line) => `${indent}  ${line}`)];
}

export function formatThread(thread: unknown): string {
  const t = record(thread);
  const root = record(t.root);
  const lines = fullMessage(root, `${text(root.channel)} `);
  const task = record(t.task);
  if (text(task.state)) {
    lines.push(`task: ${text(task.state)}${text(record(task.holder).name) ? ` held by ${text(record(task.holder).name)}` : ""}`
      + `${text(task.leaseUntil) ? ` until ${text(task.leaseUntil)}` : ""}`);
    for (const key of ["blockedReason", "result", "failureReason", "cancelReason"]) {
      if (text(task[key])) lines.push(`${key}: ${text(task[key])}`);
    }
  }
  for (const need of list(t.needs)) lines.push(`needs: ${text(need.id)} ${text(need.state)} ${firstLine(need.title)}`);
  for (const reply of list(t.replies)) lines.push(...fullMessage(reply, "  "));
  return lines.join("\n");
}

export function formatEvent(event: unknown): string {
  const e = record(event);
  const actor = record(e.actor);
  return [text(e.cursor), text(e.type), text(e.channel), text(e.messageId), `by ${text(actor.id)}`].filter(Boolean).join(" ");
}
