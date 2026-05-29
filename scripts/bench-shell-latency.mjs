#!/usr/bin/env node
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export const LIVE_TAIL_FROM_SEQ = Number.MAX_SAFE_INTEGER;

const DEFAULT_RATES = [1, 10, 30];
const DEFAULT_CONCURRENCY = [1, 5, 10];
const DEFAULT_DURATION_SECONDS = 30;
const DEFAULT_BURST_COUNT = 100;
const DEFAULT_PROFILE = "cloud";
const DEFAULT_SESSION = "bench";
const MAX_ECHO_BUFFER_CHARS = 16_384;
const RUN_SUFFIX = Date.now().toString(36).slice(-5);

const ECHO_PROGRAM = `
const marker = ${JSON.stringify("MATRIX_BENCH_READY")};
if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") process.stdin.setRawMode(true);
process.stdin.resume();
process.stdout.write(marker + " " + Date.now() + "\\n");
process.stdin.on("data", (chunk) => {
  for (const byte of chunk) {
    process.stdout.write("ECHO " + byte.toString(16).padStart(2, "0") + " " + Date.now() + "\\n");
  }
});
`;

export function parseArgs(argv) {
  const options = {
    profile: DEFAULT_PROFILE,
    gateway: undefined,
    token: undefined,
    session: DEFAULT_SESSION,
    rates: DEFAULT_RATES,
    concurrency: DEFAULT_CONCURRENCY,
    durationSeconds: DEFAULT_DURATION_SECONDS,
    burstCount: DEFAULT_BURST_COUNT,
    startupTimeoutMs: 10_000,
    echoTimeoutMs: 5_000,
    pingCount: 20,
    pingIntervalMs: 100,
    force: false,
    keepSession: false,
    csv: false,
    json: false,
    ssh: undefined,
    debugOutput: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const readValue = () => {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
      i += 1;
      return value;
    };
    if (arg === "--help" || arg === "-h") return { ...options, help: true };
    if (arg === "--profile") options.profile = readValue();
    else if (arg === "--gateway") options.gateway = readValue();
    else if (arg === "--token") options.token = readValue();
    else if (arg === "--session") options.session = readValue();
    else if (arg === "--rates") options.rates = parseNumberList(readValue(), "rates");
    else if (arg === "--concurrency") options.concurrency = parseNumberList(readValue(), "concurrency");
    else if (arg === "--duration") options.durationSeconds = parsePositiveNumber(readValue(), "duration");
    else if (arg === "--burst") options.burstCount = parsePositiveInteger(readValue(), "burst");
    else if (arg === "--startup-timeout") options.startupTimeoutMs = parsePositiveInteger(readValue(), "startup-timeout");
    else if (arg === "--echo-timeout") options.echoTimeoutMs = parsePositiveInteger(readValue(), "echo-timeout");
    else if (arg === "--ping-count") options.pingCount = parsePositiveInteger(readValue(), "ping-count");
    else if (arg === "--ping-interval") options.pingIntervalMs = parsePositiveInteger(readValue(), "ping-interval");
    else if (arg === "--ssh") options.ssh = readValue();
    else if (arg === "--debug-output") options.debugOutput = true;
    else if (arg === "--force") options.force = true;
    else if (arg === "--keep-session") options.keepSession = true;
    else if (arg === "--csv") options.csv = true;
    else if (arg === "--json") options.json = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  validateSessionPrefix(options.session);
  return options;
}

export function buildEchoCommand() {
  const encoded = Buffer.from(ECHO_PROGRAM, "utf8").toString("base64");
  return `node -e "eval(Buffer.from('${encoded}','base64').toString('utf8'))"`;
}

export function parseEchoes(state, chunk, onEcho) {
  state.buffer = `${state.buffer}${normalizeTerminalText(chunk)}`;
  const ready = state.buffer.includes("MATRIX_BENCH_READY");
  const regex = /ECHO ([0-9a-f]{2}) (\d{10,})/g;
  let match;
  let lastIndex = 0;
  while ((match = regex.exec(state.buffer)) !== null) {
    lastIndex = regex.lastIndex;
    onEcho({ hex: match[1], remoteTime: Number(match[2]) });
  }
  if (lastIndex > 0) state.buffer = state.buffer.slice(lastIndex);
  if (state.buffer.length > MAX_ECHO_BUFFER_CHARS) {
    state.buffer = state.buffer.slice(-MAX_ECHO_BUFFER_CHARS);
  }
  return { ready };
}

export function normalizeTerminalText(value) {
  return String(value)
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b[()][A-Za-z0-9]/g, "")
    .replace(/\u001b[@-_]/g, "")
    .replace(/[^\x20-\x7e\n]/g, "");
}

export function summarizeLatencies(latenciesMs, inputBytes, outputBytes, disconnects) {
  const sorted = latenciesMs
    .filter((value) => typeof value === "number" && Number.isFinite(value))
    .sort((a, b) => a - b);
  const percentile = (p) => {
    if (sorted.length === 0) return null;
    const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
    return roundMs(sorted[index]);
  };
  return {
    count: sorted.length,
    p50: percentile(50),
    p95: percentile(95),
    p99: percentile(99),
    max: sorted.length > 0 ? roundMs(sorted[sorted.length - 1]) : null,
    inputBytes,
    outputBytes,
    disconnects,
  };
}

export function formatCsv(rows) {
  const header = [
    "mode",
    "rate",
    "concurrency",
    "sent",
    "received",
    "missing",
    "p50",
    "p95",
    "p99",
    "max",
    "inputBytesPerSec",
    "outputBytesPerSec",
    "disconnects",
  ];
  const lines = [header.join(",")];
  for (const row of rows) {
    lines.push(header.map((key) => csvCell(row[key])).join(","));
  }
  return lines.join("\n");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const profile = await resolveProfile(options);
  const WebSocket = await loadWebSocket();
  const runs = buildRunPlan(options);
  const results = [];

  for (const run of runs) {
    const serverBefore = options.ssh ? await sampleServerLoad(options.ssh).catch((err) => ({ error: safeError(err) })) : null;
    const result = await runOneBenchmark({ run, options, profile, WebSocket });
    const serverAfter = options.ssh ? await sampleServerLoad(options.ssh).catch((err) => ({ error: safeError(err) })) : null;
    results.push({ ...result, serverBefore, serverAfter });
    if (!options.json && !options.csv) printHumanRow(results[results.length - 1]);
  }

  if (options.csv) {
    console.log(formatCsv(results.map(flattenResultForCsv)));
  } else if (options.json || !process.stdout.isTTY) {
    console.log(JSON.stringify({ generatedAt: new Date().toISOString(), gateway: profile.gateway, results }, null, 2));
  }
}

async function runOneBenchmark({ run, options, profile, WebSocket }) {
  const sessions = sessionNames(options.session, run.concurrency, run.id);
  const clients = [];
  const startedAt = Date.now();
  let network = null;

  try {
    for (const session of sessions) {
      if (options.force) {
        await deleteSession(profile, session).catch((err) => {
          if (!isNotFoundError(err)) throw err;
        });
      }
      await createSession(profile, session);
      await delay(250);
      const client = await attachEchoClientWithRetry({
        profile,
        session,
        WebSocket,
        startupTimeoutMs: options.startupTimeoutMs,
      });
      clients.push(client);
    }

    network = await measureNetworkPing(clients[0], {
      count: options.pingCount,
      intervalMs: options.pingIntervalMs,
    });

    const perClient = await Promise.all(clients.map((client) => runClientLoad(client, {
      mode: run.mode,
      rate: run.rate,
      count: run.count,
      echoTimeoutMs: options.echoTimeoutMs,
    })));
    const endedAt = Date.now();
    const aggregate = aggregateClientResults(perClient, (endedAt - startedAt) / 1000);

    return {
      mode: run.mode,
      rate: run.rate,
      concurrency: run.concurrency,
      durationSeconds: roundMs((endedAt - startedAt) / 1000),
      sent: aggregate.sent,
      received: aggregate.received,
      missing: aggregate.missing,
      keystrokeRtt: aggregate.keystrokeRtt,
      networkRtt: network,
      inputBytesPerSec: aggregate.inputBytesPerSec,
      outputBytesPerSec: aggregate.outputBytesPerSec,
      clients: perClient.map(({ latencies, debugTail, ...client }) => ({
        ...client,
        ...(options.debugOutput ? { debugTail } : {}),
      })),
    };
  } finally {
    for (const client of clients) client.close();
    if (!options.keepSession) {
      for (const session of sessions) {
        await deleteSession(profile, session).catch((err) => {
          console.warn(`[bench] failed to delete ${session}: ${safeError(err)}`);
        });
      }
    }
  }
}

async function attachEchoClientWithRetry(options) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await attachEchoClient(options);
    } catch (err) {
      lastError = err;
      if (attempt < 3) await delay(250 * attempt);
    }
  }
  throw lastError;
}

async function attachEchoClient({ profile, session, WebSocket, startupTimeoutMs }) {
  const url = attachUrl(profile.gateway, session, profile.token);
  const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${profile.token}` } });
  const state = {
    session,
    ws,
    outputBytes: 0,
    pendingTokens: [],
    latencies: [],
    disconnects: 0,
    parser: { buffer: "" },
    matchBuffer: "",
    debugTail: "",
    attached: false,
    ready: false,
  };

  ws.on("close", () => {
    state.disconnects += 1;
  });
  ws.on("message", (raw) => {
    const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
    let msg;
    try {
      msg = JSON.parse(text);
    } catch (err) {
      console.warn(`[bench] ignored non-JSON websocket frame: ${safeError(err)}`);
      return;
    }
    if (msg?.type === "attached") {
      state.attached = true;
      return;
    }
    if (msg?.type === "error") {
      state.error = typeof msg.code === "string" ? msg.code : "attach_failed";
      return;
    }
    if (msg?.type !== "output" || typeof msg.data !== "string") return;
    state.outputBytes += Buffer.byteLength(msg.data);
    const normalized = normalizeTerminalText(msg.data);
    state.debugTail = `${state.debugTail}${normalized}`.slice(-4_000);
    consumePromptEchoes(state, normalized);
    const parsed = parseEchoes(state.parser, normalized, () => undefined);
    if (parsed.ready) state.ready = true;
  });

  try {
    await waitForOpen(ws, startupTimeoutMs);
    await waitUntil(() => {
      if (state.error) throw new Error(`terminal session attach failed in ${session}: ${state.error}`);
      return state.attached;
    }, startupTimeoutMs, `terminal session did not attach in ${session}`);
    ws.send(JSON.stringify({ type: "resize", cols: 120, rows: 40 }));
    state.ready = true;
  } catch (err) {
    ws.close();
    throw err;
  }

  return {
    session,
    state,
    ping: () => pingWebSocket(ws),
    sendSample(index) {
      const token = sampleToken(index);
      state.pendingTokens.push({ token, sentAt: performance.now() });
      const data = token;
      ws.send(JSON.stringify({ type: "input", data }));
      return Buffer.byteLength(data);
    },
    close() {
      try {
        ws.send(JSON.stringify({ type: "detach" }));
      } catch (err) {
        console.warn(`[bench] failed to send detach: ${safeError(err)}`);
      }
      ws.close();
    },
  };
}

async function runClientLoad(client, run) {
  let inputBytes = 0;
  const beforeOutput = client.state.outputBytes;
  const beforeDisconnects = client.state.disconnects;
  const beforeLatencyCount = client.state.latencies.length;
  for (let i = 0; i < run.count; i += 1) {
    inputBytes += client.sendSample(i);
    if (run.mode === "rate") await delay(1000 / run.rate);
  }
  await waitForEchoDrain(client, run.echoTimeoutMs);
  const latencies = client.state.latencies.slice(beforeLatencyCount);
  const missing = client.state.pendingTokens.length;
  const summary = summarizeLatencies(
    latencies,
    inputBytes,
    client.state.outputBytes - beforeOutput,
    client.state.disconnects - beforeDisconnects,
  );
  return {
    session: client.session,
    sent: run.count,
    received: summary.count,
    missing,
    latencies,
    debugTail: client.state.debugTail,
    keystrokeRtt: summary,
  };
}

async function measureNetworkPing(client, options) {
  const latencies = [];
  for (let i = 0; i < options.count; i += 1) {
    const rtt = await client.ping();
    if (typeof rtt === "number") latencies.push(rtt);
    await delay(options.intervalMs);
  }
  return summarizeLatencies(latencies, 0, 0, 0);
}

function pingWebSocket(ws) {
  if (typeof ws.ping !== "function") return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const startedAt = performance.now();
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("websocket_ping_timeout"));
    }, 5_000);
    const onPong = () => {
      cleanup();
      resolve(performance.now() - startedAt);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      ws.off("pong", onPong);
    };
    ws.on("pong", onPong);
    ws.ping();
  });
}

async function waitForEchoDrain(client, timeoutMs) {
  const startedAt = Date.now();
  while (client.state.pendingTokens.length > 0 && Date.now() - startedAt <= timeoutMs) {
    await delay(25);
  }
}

function aggregateClientResults(results, elapsedSeconds) {
  const latencies = [];
  let inputBytes = 0;
  let outputBytes = 0;
  let disconnects = 0;
  let sent = 0;
  let received = 0;
  let missing = 0;
  for (const result of results) {
    latencies.push(...result.latencies);
    inputBytes += result.keystrokeRtt.inputBytes;
    outputBytes += result.keystrokeRtt.outputBytes;
    disconnects += result.keystrokeRtt.disconnects;
    sent += result.sent;
    received += result.received;
    missing += result.missing;
  }
  return {
    sent,
    received,
    missing,
    keystrokeRtt: summarizeLatencies(latencies, inputBytes, outputBytes, disconnects),
    inputBytesPerSec: roundMs(inputBytes / Math.max(elapsedSeconds, 0.001)),
    outputBytesPerSec: roundMs(outputBytes / Math.max(elapsedSeconds, 0.001)),
  };
}

function buildRunPlan(options) {
  const runs = [];
  let id = 0;
  for (const concurrency of options.concurrency) {
    for (const rate of options.rates) {
      runs.push({
        id: id++,
        mode: "rate",
        rate,
        concurrency,
        count: Math.max(1, Math.round(rate * options.durationSeconds)),
      });
    }
    runs.push({
      id: id++,
      mode: "burst",
      rate: null,
      concurrency,
      count: options.burstCount,
    });
  }
  return runs;
}

function sessionNames(prefix, concurrency, runId) {
  const root = `${prefix.slice(0, 18).replace(/-+$/, "")}-${RUN_SUFFIX}-${runId}`;
  if (concurrency === 1) return [root];
  return Array.from({ length: concurrency }, (_, index) => `${root}-${index + 1}`);
}

function attachUrl(gateway, session, token) {
  const url = new URL("/ws/terminal/session", gateway);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("session", session);
  url.searchParams.set("fromSeq", String(LIVE_TAIL_FROM_SEQ));
  url.searchParams.set("token", token);
  return url.toString();
}

async function createSession(profile, session) {
  await requestJson(profile, "/api/terminal/sessions", {
    method: "POST",
    body: JSON.stringify({ name: session }),
  });
}

async function deleteSession(profile, session) {
  await requestJson(profile, `/api/terminal/sessions/${encodeURIComponent(session)}?force=1`, {
    method: "DELETE",
  });
}

async function requestJson(profile, path, init) {
  const response = await fetch(new URL(path, profile.gateway), {
    ...init,
    headers: {
      Authorization: `Bearer ${profile.token}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    let code = `http_${response.status}`;
    try {
      const body = await response.json();
      if (typeof body?.error?.code === "string") code = body.error.code;
      else if (typeof body?.error === "string") code = body.error;
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err;
    }
    throw Object.assign(new Error(`Request failed: ${code}`), { code });
  }
  try {
    return await response.json();
  } catch (err) {
    if (err instanceof SyntaxError) return {};
    throw err;
  }
}

async function resolveProfile(options) {
  const registryPath = join(homedir(), ".matrixos", "profiles.json");
  const registry = JSON.parse(await readFile(registryPath, "utf8"));
  const profileName = options.profile ?? registry.active ?? DEFAULT_PROFILE;
  const profile = registry.profiles?.[profileName];
  if (!profile && (!options.gateway || !options.token)) {
    throw new Error(`Matrix profile not found: ${profileName}`);
  }
  const auth = options.token
    ? { accessToken: options.token, expiresAt: Date.now() + 60_000 }
    : JSON.parse(await readFile(join(homedir(), ".matrixos", "profiles", profileName, "auth.json"), "utf8"));
  if (typeof auth.expiresAt === "number" && Date.now() >= auth.expiresAt) {
    throw new Error(`Matrix profile auth is expired: ${profileName}`);
  }
  return {
    profile: profileName,
    gateway: options.gateway ?? profile.gatewayUrl,
    token: auth.accessToken,
  };
}

async function loadWebSocket() {
  try {
    const mod = await import(new URL("../packages/sync-client/node_modules/ws/index.js", import.meta.url));
    return mod.WebSocket ?? mod.default;
  } catch (err) {
    if (globalThis.WebSocket) return globalThis.WebSocket;
    throw new Error(`Could not load WebSocket implementation: ${safeError(err)}`);
  }
}

async function sampleServerLoad(sshTarget) {
  const script = `
const fs = require("fs");
const cp = require("child_process");
function out(cmd, args) {
  try { return cp.execFileSync(cmd, args, { encoding: "utf8" }).trim(); }
  catch (err) { void err; return ""; }
}
function pids(pattern) {
  return out("pgrep", ["-f", pattern]).split(/\\s+/).filter(Boolean);
}
function psRows(ids) {
  if (ids.length === 0) return [];
  return out("ps", ["-o", "pid=,pcpu=,rss=,comm=", "-p", ids.join(",")])
    .split(/\\n/)
    .map((line) => line.trim().split(/\\s+/, 4))
    .filter((parts) => parts.length >= 4)
    .map(([pid, cpu, rss, comm]) => ({ pid: Number(pid), cpuPercent: Number(cpu), rssKb: Number(rss), comm }));
}
const gatewayPids = pids("matrix-gateway|gateway|node.*main");
const zellijPids = pids("zellij");
const gatewayFdCount = gatewayPids.reduce((sum, pid) => {
  try { return sum + fs.readdirSync("/proc/" + pid + "/fd").length; }
  catch (err) { void err; return sum; }
}, 0);
console.log(JSON.stringify({
  sampledAt: new Date().toISOString(),
  loadAverage: fs.readFileSync("/proc/loadavg", "utf8").trim(),
  gateway: psRows(gatewayPids),
  zellij: psRows(zellijPids),
  gatewayFdCount
}));
`;
  const stdout = await execFilePromise("ssh", [
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    sshTarget,
    "node",
    "-e",
    script,
  ], 15_000);
  return JSON.parse(stdout);
}

function execFilePromise(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr ? stderr.trim() : err.message));
        return;
      }
      resolve(String(stdout));
    });
  });
}

function waitForOpen(ws, timeoutMs) {
  if (ws.readyState === 1) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("websocket_open_timeout"));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timeout);
      ws.off("open", onOpen);
      ws.off("error", onError);
    };
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = (err) => {
      cleanup();
      reject(err);
    };
    ws.on("open", onOpen);
    ws.on("error", onError);
  });
}

async function waitUntil(predicate, timeoutMs, message) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error(message);
    await delay(25);
  }
}

function parseNumberList(value, label) {
  const values = value.split(",").map((item) => parsePositiveNumber(item.trim(), label));
  if (values.length === 0) throw new Error(`Empty ${label}`);
  return values;
}

function parsePositiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`Invalid ${label}: ${value}`);
  return parsed;
}

function parsePositiveNumber(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`Invalid ${label}: ${value}`);
  return parsed;
}

function validateSessionPrefix(value) {
  if (!/^bench(?:-[a-z0-9-]{1,20})?$/.test(value)) {
    throw new Error("Benchmark session must be named 'bench' or start with 'bench-'");
  }
}

function sampleToken(index) {
  return `MB${index.toString(36).padStart(6, "0")}Z`;
}

function consumePromptEchoes(state, normalized) {
  state.matchBuffer = `${state.matchBuffer}${normalized}`.slice(-8_000);
  while (state.pendingTokens.length > 0) {
    const pending = state.pendingTokens[0];
    const index = state.matchBuffer.indexOf(pending.token);
    if (index === -1) return;
    state.latencies.push(performance.now() - pending.sentAt);
    state.pendingTokens.shift();
    state.matchBuffer = state.matchBuffer.slice(index + pending.token.length);
  }
}

function isNotFoundError(err) {
  return err && typeof err === "object" && "code" in err && err.code === "session_not_found";
}

function roundMs(value) {
  return Math.round(value * 100) / 100;
}

function csvCell(value) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function flattenResultForCsv(result) {
  return {
    mode: result.mode,
    rate: result.rate,
    concurrency: result.concurrency,
    sent: result.sent,
    received: result.received,
    missing: result.missing,
    p50: result.keystrokeRtt.p50,
    p95: result.keystrokeRtt.p95,
    p99: result.keystrokeRtt.p99,
    max: result.keystrokeRtt.max,
    inputBytesPerSec: result.inputBytesPerSec,
    outputBytesPerSec: result.outputBytesPerSec,
    disconnects: result.keystrokeRtt.disconnects,
  };
}

function printHumanRow(result) {
  const rtt = result.keystrokeRtt;
  const network = result.networkRtt;
  console.log([
    `[${result.mode}]`,
    `rate=${result.rate ?? "burst"}`,
    `clients=${result.concurrency}`,
    `sent=${result.sent}`,
    `received=${result.received}`,
    `missing=${result.missing}`,
    `p50=${rtt.p50 ?? "n/a"}ms`,
    `p95=${rtt.p95 ?? "n/a"}ms`,
    `p99=${rtt.p99 ?? "n/a"}ms`,
    `max=${rtt.max ?? "n/a"}ms`,
    `wsPingP50=${network?.p50 ?? "n/a"}ms`,
  ].join(" "));
}

function printHelp() {
  console.log(`Usage: node scripts/bench-shell-latency.mjs [options]

Creates dedicated bench-prefixed terminal sessions and measures live-tail terminal echo latency.

Options:
  --profile <name>          CLI profile to use (default: cloud)
  --gateway <url>           Override gateway URL
  --token <token>           Override bearer/query token
  --session <name>          bench-prefixed session name (default: bench)
  --rates <csv>             Key rates per client, comma-separated (default: 1,10,30)
  --duration <seconds>      Duration per rate run (default: 30)
  --burst <count>           Burst count per client (default: 100)
  --concurrency <csv>       Concurrent clients, comma-separated (default: 1,5,10)
  --force                   Delete existing bench sessions before each run
  --keep-session            Leave bench sessions behind after the run
  --ssh <user@host>         Sample server load before/after each run
  --debug-output            Include normalized terminal output tails in JSON
  --json                    Print JSON
  --csv                     Print CSV

Example:
  node scripts/bench-shell-latency.mjs --force --json
  node scripts/bench-shell-latency.mjs --force --rates 10 --concurrency 1 --duration 10 --ssh matrix@1.2.3.4
`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`bench-shell-latency failed: ${safeError(err)}`);
    process.exitCode = 1;
  });
}

function safeError(err) {
  return err instanceof Error ? err.message : String(err);
}
