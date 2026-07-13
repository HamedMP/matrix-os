import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { createInterface } from "node:readline";
import { StringDecoder } from "node:string_decoder";
import { z } from "zod/v4";

process.on("uncaughtException", () => {
  process.stderr.write("Codex event runner stopped unexpectedly.\n");
  process.exit(1);
});
process.on("unhandledRejection", () => {
  process.stderr.write("Codex event runner stopped unexpectedly.\n");
  process.exit(1);
});

const MAX_JSON_LINE_BYTES = 64 * 1024;
const MAX_TRANSCRIPT_BYTES = 16 * 1024 * 1024;
const MAX_PENDING_PROMPTS = 20;
const MAX_PROMPT_BYTES = 64 * 1024;
const TURN_TIMEOUT_MS = 10 * 60 * 1000;
const PROVIDER_THREAD_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,511}$/;
const RunnerInputSchema = z.object({
  eventPath: z.string().min(1).max(4096).refine(isAbsolute).regex(/^[^\u0000\r\n]+\.jsonl$/),
  command: z.string().min(1).max(4096).regex(/^[^\u0000\r\n]+$/),
  initialArgs: z.array(z.string().max(100_000)).min(1).max(128),
}).strict().superRefine((value, context) => {
  if (!value.initialArgs.includes("exec") || !value.initialArgs.includes("--json")) {
    context.addIssue({ code: "custom", message: "Structured output flags are required" });
  }
});
const RunnerEventSchema = z.object({
  type: z.string().min(1).max(80),
  thread_id: z.string().max(512).optional(),
  item: z.object({
    type: z.string().min(1).max(80),
    text: z.string().max(MAX_JSON_LINE_BYTES).optional(),
  }).passthrough().optional(),
}).passthrough();
const PendingPromptSchema = z.string().trim().min(1).max(MAX_PROMPT_BYTES);

const parsedInput = RunnerInputSchema.safeParse({
  eventPath: process.argv[2],
  command: process.argv[3],
  initialArgs: process.argv.slice(4),
});
if (!parsedInput.success) {
  process.stderr.write("Codex event runner configuration is invalid.\n");
  process.exit(1);
}
const { eventPath, command, initialArgs } = parsedInput.data;

await mkdir(dirname(eventPath), { recursive: true });
try {
  const existing = await lstat(eventPath);
  if (existing.isSymbolicLink() || !existing.isFile()) {
    throw new Error("unsafe_event_file");
  }
} catch (error) {
  if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
}

const noFollow = constants.O_NOFOLLOW ?? 0;
const eventFile = await open(
  eventPath,
  constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | noFollow,
  0o600,
);
let transcriptBytes = (await eventFile.stat()).size;
let providerThreadId;
let activeChild;
let stopping = false;
let fatalTransportFailure = false;
let stdinClosed = false;
const pendingPrompts = [];
let wakePrompt;

function safeTerminalLine(raw) {
  let value;
  try {
    const parsed = RunnerEventSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return;
    value = parsed.data;
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      process.stdout.write("Codex: Activity could not be displayed.\n");
    }
    return;
  }
  if (!value || typeof value !== "object") return;
  if (value.type === "thread.started" && PROVIDER_THREAD_ID.test(value.thread_id ?? "")) {
    providerThreadId = value.thread_id;
    return;
  }
  if (value.type === "item.started" && value.item?.type === "command_execution") {
    process.stdout.write("Codex: Running command.\n");
    return;
  }
  if (value.type === "item.started" && value.item?.type === "file_change") {
    process.stdout.write("Codex: Updating files.\n");
    return;
  }
  if (value.type === "item.completed" && value.item?.type === "agent_message") {
    const text = typeof value.item.text === "string" ? value.item.text : "";
    if (text.trim()) {
      process.stdout.write(`${Array.from(text).slice(0, 8_000).join("")}\n`);
    }
    return;
  }
  if (value.type === "turn.completed") {
    process.stdout.write("Codex: Turn complete.\n");
    return;
  }
  if (value.type === "turn.failed" || value.type === "error") {
    process.stdout.write("Codex: Turn needs attention.\n");
  }
}

async function persistLine(line) {
  const bytes = Buffer.byteLength(`${line}\n`, "utf-8");
  if (bytes > MAX_JSON_LINE_BYTES || transcriptBytes + bytes > MAX_TRANSCRIPT_BYTES) {
    fatalTransportFailure = true;
    throw new Error("event_transcript_limit");
  }
  await eventFile.write(`${line}\n`);
  transcriptBytes += bytes;
  safeTerminalLine(line);
  try {
    const parsed = RunnerEventSchema.safeParse(JSON.parse(line));
    return parsed.success ? parsed.data.type : undefined;
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

async function consumeStdout(stream) {
  const decoder = new StringDecoder("utf-8");
  let pending = "";
  const eventTypes = [];
  for await (const chunk of stream) {
    pending += decoder.write(chunk);
    if (Buffer.byteLength(pending, "utf-8") > MAX_JSON_LINE_BYTES * 2) {
      fatalTransportFailure = true;
      throw new Error("event_line_limit");
    }
    let newline = pending.indexOf("\n");
    while (newline >= 0) {
      const line = pending.slice(0, newline).replace(/\r$/, "");
      pending = pending.slice(newline + 1);
      if (line.length > 0) eventTypes.push(await persistLine(line));
      newline = pending.indexOf("\n");
    }
  }
  pending += decoder.end();
  if (pending.length > 0) eventTypes.push(await persistLine(pending.replace(/\r$/, "")));
  return eventTypes;
}

async function discardStderr(stream) {
  for await (const _chunk of stream) {
    // Provider stderr can contain credentials, private paths, or raw failures.
  }
}

function childExit(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
}

async function runCodex(args) {
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  activeChild = child;
  const timeout = setTimeout(() => child.kill("SIGTERM"), TURN_TIMEOUT_MS);
  timeout.unref();
  try {
    const [exit, eventTypes] = await Promise.all([
      childExit(child),
      consumeStdout(child.stdout),
      discardStderr(child.stderr),
    ]);
    if (exit.code !== 0 && !eventTypes.includes("turn.failed")) {
      await persistLine(JSON.stringify({ type: "turn.failed" }));
    }
    return exit.code === 0;
  } catch (error) {
    child.kill("SIGTERM");
    await persistLine(JSON.stringify({ type: "turn.failed" })).catch(() => undefined);
    if (fatalTransportFailure) stopping = true;
    return false;
  } finally {
    clearTimeout(timeout);
    activeChild = undefined;
  }
}

function enqueuePrompt(line) {
  const parsed = PendingPromptSchema.safeParse(line);
  if (!parsed.success || Buffer.byteLength(parsed.data, "utf-8") > MAX_PROMPT_BYTES) return;
  const prompt = parsed.data;
  if (pendingPrompts.length >= MAX_PENDING_PROMPTS) {
    process.stdout.write("Codex: Too many pending messages. Try again shortly.\n");
    return;
  }
  pendingPrompts.push(prompt);
  wakePrompt?.();
  wakePrompt = undefined;
}

function nextPrompt() {
  if (pendingPrompts.length > 0) return Promise.resolve(pendingPrompts.shift());
  if (stdinClosed || stopping) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    wakePrompt = () => resolve(pendingPrompts.shift());
  });
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", enqueuePrompt);
input.on("close", () => {
  stdinClosed = true;
  wakePrompt?.();
  wakePrompt = undefined;
});

function stop() {
  stopping = true;
  activeChild?.kill("SIGTERM");
  input.close();
}
process.once("SIGTERM", stop);
process.once("SIGINT", stop);

let exitCode = 0;
try {
  if (!await runCodex(initialArgs)) exitCode = 1;
  const execIndex = initialArgs.indexOf("exec");
  const globalArgs = execIndex >= 0 ? initialArgs.slice(0, execIndex) : [];
  while (!stopping && !fatalTransportFailure) {
    const prompt = await nextPrompt();
    if (!prompt) break;
    if (!providerThreadId) {
      process.stdout.write("Codex: This conversation cannot be resumed. Start a new chat.\n");
      exitCode = 1;
      continue;
    }
    const resumed = await runCodex([
      ...globalArgs,
      "exec",
      "resume",
      "--json",
      "--skip-git-repo-check",
      providerThreadId,
      "--",
      prompt,
    ]);
    if (!resumed) exitCode = 1;
  }
} finally {
  input.close();
  await eventFile.close();
}
process.exitCode = exitCode;
