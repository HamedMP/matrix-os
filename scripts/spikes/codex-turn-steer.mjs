import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const CODEX_VERSION = "0.151.0";
const spikeRoot = await mkdtemp(join(tmpdir(), "matrix-codex-steer-"));
const child = spawn(
  "pnpm",
  ["dlx", `@openai/codex@${CODEX_VERSION}`, "app-server"],
  { stdio: ["pipe", "pipe", "pipe"], cwd: spikeRoot },
);
const pending = new Map();
const events = [];
const eventWaiters = new Set();
const responseOrder = [];
let nextId = 1;

function send(value) {
  child.stdin.write(`${JSON.stringify(value)}\n`);
}

function request(method, params, label = method) {
  const id = nextId++;
  send({ id, method, params });
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timeout:${label}`));
    }, 45_000);
    pending.set(id, { resolve, reject, timeout, label });
  });
}

function waitForEvent(predicate, label) {
  const existing = events.find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      eventWaiters.delete(waiter);
      reject(new Error(`timeout:${label}`));
    }, 60_000);
    const waiter = { predicate, resolve, timeout };
    eventWaiters.add(waiter);
  });
}

function acceptEvent(event) {
  events.push(event);
  for (const waiter of [...eventWaiters]) {
    if (!waiter.predicate(event)) continue;
    clearTimeout(waiter.timeout);
    eventWaiters.delete(waiter);
    waiter.resolve(event);
  }
}

function respondToServerRequest(message) {
  if (message.method === "item/commandExecution/requestApproval"
    || message.method === "item/fileChange/requestApproval") {
    send({ id: message.id, result: { decision: "decline" } });
    return;
  }
  if (message.method === "item/tool/requestUserInput") {
    send({ id: message.id, result: { answers: {} } });
    return;
  }
  send({ id: message.id, error: { code: -32601, message: "Unavailable in spike" } });
}

const stdout = createInterface({ input: child.stdout, crlfDelay: Infinity });
stdout.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch (error) {
    console.warn(
      "[codex-turn-steer] Ignoring malformed output:",
      error instanceof Error ? error.name : "UnknownError",
    );
    return;
  }
  if (message.id !== undefined && message.method) {
    respondToServerRequest(message);
    return;
  }
  if (message.id !== undefined) {
    const item = pending.get(message.id);
    if (!item) return;
    clearTimeout(item.timeout);
    pending.delete(message.id);
    responseOrder.push(item.label);
    if (message.error) {
      const error = new Error("rpc_rejected");
      error.rpc = message.error;
      item.reject(error);
    } else {
      item.resolve(message.result);
    }
    return;
  }
  if (message.method) acceptEvent(message);
});
// Provider stderr can contain local paths or credentials; the spike never publishes it.
child.stderr.resume();

function completionFor(turnId) {
  return waitForEvent(
    (event) => event.method === "turn/completed" && event.params?.turn?.id === turnId,
    "turn completion",
  );
}

function deltasFor(turnId) {
  return events
    .filter((event) => event.method === "item/agentMessage/delta" && event.params?.turnId === turnId)
    .map((event) => event.params?.delta ?? "")
    .join("");
}

function rejectionCategory(error) {
  const message = typeof error?.rpc?.message === "string" ? error.rpc.message : "";
  if (/expected active turn/i.test(message)) return "expected_turn_mismatch";
  if (/no active turn/i.test(message)) return "no_active_turn";
  return "rpc_rejected";
}

let summary;
try {
  await request("initialize", {
    clientInfo: { name: "matrix-os-steer-spike", title: "Matrix OS Steer Spike", version: "1" },
    capabilities: { experimentalApi: true },
  });
  send({ method: "initialized", params: {} });
  const startedThread = await request("thread/start", {
    cwd: spikeRoot,
    approvalPolicy: "never",
    sandbox: "read-only",
    ephemeral: true,
    experimentalRawEvents: false,
  });
  const threadId = startedThread.thread.id;

  const firstStarted = await request("turn/start", {
    threadId,
    input: [{
      type: "text",
      text: "Run the shell command `sleep 8`, wait for it to finish, then reply exactly INITIAL_DONE. Do not do anything else.",
      text_elements: [],
    }],
  });
  const firstTurnId = firstStarted.turn.id;
  let staleRejection;
  try {
    await request("turn/steer", {
      threadId,
      expectedTurnId: "turn_stale_probe",
      input: [{ type: "text", text: "stale steer", text_elements: [] }],
    }, "stale-steer");
  } catch (error) {
    staleRejection = rejectionCategory(error);
  }
  const validSteer = await request("turn/steer", {
    threadId,
    expectedTurnId: firstTurnId,
    input: [{
      type: "text",
      text: "After the sleep finishes, reply exactly STEER_APPLIED instead of INITIAL_DONE.",
      text_elements: [],
    }],
  }, "valid-steer");
  const firstCompleted = await completionFor(firstTurnId);
  const firstText = deltasFor(firstTurnId);

  const secondStarted = await request("turn/start", {
    threadId,
    input: [{
      type: "text",
      text: "Run the shell command `sleep 8`, then reply exactly RACE_INITIAL.",
      text_elements: [],
    }],
  });
  const secondTurnId = secondStarted.turn.id;
  const raceStart = responseOrder.length;
  const raceSteerPromise = request("turn/steer", {
    threadId,
    expectedTurnId: secondTurnId,
    input: [{ type: "text", text: "Reply exactly RACE_STEERED.", text_elements: [] }],
  }, "race-steer").then(
    (result) => ({ accepted: true, sameTurn: result.turnId === secondTurnId }),
    (error) => ({ accepted: false, rejection: rejectionCategory(error) }),
  );
  const interruptPromise = request("turn/interrupt", {
    threadId,
    turnId: secondTurnId,
  }, "race-interrupt").then(
    () => ({ accepted: true }),
    (error) => ({ accepted: false, rejection: rejectionCategory(error) }),
  );
  const [raceSteer, interrupt] = await Promise.all([raceSteerPromise, interruptPromise]);
  const raceResponseOrder = responseOrder.slice(raceStart);
  const secondCompleted = await completionFor(secondTurnId);

  let terminalRejection;
  try {
    await request("turn/steer", {
      threadId,
      expectedTurnId: secondTurnId,
      input: [{ type: "text", text: "too late", text_elements: [] }],
    }, "completed-turn-steer");
  } catch (error) {
    terminalRejection = rejectionCategory(error);
  }

  summary = {
    codexVersion: CODEX_VERSION,
    validSteerAcknowledgedSameTurn: validSteer.turnId === firstTurnId,
    staleExpectedTurnRejected: staleRejection === "expected_turn_mismatch",
    firstTurnStatus: firstCompleted.params.turn.status,
    steerInstructionObserved: firstText.includes("STEER_APPLIED"),
    originalInstructionSuppressed: !firstText.includes("INITIAL_DONE"),
    race: {
      steer: raceSteer,
      interrupt,
      responseOrder: raceResponseOrder,
      terminalStatus: secondCompleted.params.turn.status,
    },
    completedTurnSteerRejected: terminalRejection === "no_active_turn",
  };
} finally {
  child.kill("SIGTERM");
  setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
  await rm(spikeRoot, { recursive: true, force: true });
}

process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
