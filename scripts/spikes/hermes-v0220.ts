/** Existing official runtime only: node --import=tsx scripts/spikes/hermes-v0220.ts /tmp/eng306-runtime */
import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createServer, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { resolveHermesPython } from "../../packages/gateway/src/chat/hermes-python-environment.js";
import { verifyJevHermesDependencies, verifyJevHermesRuntimePin } from "../../packages/gateway/src/chat/jev-hermes-runtime-pin.js";
import { createHermesChatProviderAdapter } from "../../packages/gateway/src/chat/hermes-provider-adapter.js";
import type { HermesGatewaySpawn } from "../../packages/gateway/src/chat/hermes-stdio-client.js";
import type { CanonicalProviderRunEvent } from "../../packages/gateway/src/chat/provider-adapter.js";

const runtime = await realpath(process.argv[2] ?? "");
assert.equal(runtime, await realpath("/tmp/eng306-runtime"), "Use only the existing task-owned runtime");
const source = join(runtime, ".hermes/hermes-agent");
const deadline = AbortSignal.timeout(120_000);
await verifyJevHermesRuntimePin(source, deadline);
await verifyJevHermesDependencies(source, "anthropic_messages", deadline);
const python = await resolveHermesPython(source);
const run = promisify(execFile);
const version = await run(python, ["--version"], { timeout: 5000, env: { PATH: "/usr/bin:/bin" } });
const sdk = await run(python, ["-I", "-c", "import importlib.util; print('present' if importlib.util.find_spec('mcp') else 'missing')"], { timeout: 10000, env: { PATH: "/usr/bin:/bin" } });
const home = await mkdtemp(join(tmpdir(), "eng306-native-fixture-"));
const children: ChildProcess[] = [];
const exits: Promise<void>[] = [];
const rpc: { child: number; method: string; session?: string }[] = [];
const failures: string[] = [];
const completedRows: unknown[] = [];
let blockedNetworkAttempts = 0;
let requests = 0;
let toolRoundTrip = false;
let resumedHistory = false;
let cancelResponse: ServerResponse | undefined;
let acceptHeld!: () => void;
const held = new Promise<void>(accept => { acceptHeld = accept; });
const marker = "ENG306_SYNTHETIC_FILE_CONTENT";
const server = createServer(async (request, response) => {
  try {
    const chunks: Buffer[] = []; let bytes = 0;
    for await (const chunk of request) { bytes += chunk.length; assert(bytes <= 1_048_576); chunks.push(chunk); }
    assert(request.method === "POST" && request.url === "/v1/chat/completions", "unexpected fixture endpoint");
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    assert.equal(body.model, "gpt-4o-mini"); assert(++requests <= 4, "unexpected auxiliary/retry inference");
    const messages = body.messages as { role: string; content: unknown }[];
    const lastUser = JSON.stringify(messages.filter(message => message.role === "user").at(-1)?.content);
    let text = ""; let call: object | undefined;
    if (lastUser.includes("ENG306_CANCEL")) {
      cancelResponse = response;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({ id: "held", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: { role: "assistant", content: "held" }, finish_reason: null }] })}\n\n`);
      acceptHeld(); return;
    } else if (lastUser.includes("ENG306_RESUME")) {
      assert(messages.some(message => message.role === "assistant" && JSON.stringify(message.content).includes("ENG306 first turn.")), "resume lost the first assistant message");
      assert(messages.some(message => message.role === "tool" && JSON.stringify(message.content).includes(marker)), "resume lost the genuine tool result");
      resumedHistory = true; text = "ENG306 continued turn.";
    } else if (messages.some(message => message.role === "tool" && JSON.stringify(message.content).includes(marker))) {
      toolRoundTrip = true; text = "ENG306 first turn.";
    } else {
      assert(lastUser.includes("ENG306_READ"), "unexpected first prompt");
      assert(body.tools?.some((tool: { function?: { name?: string } }) => tool.function?.name === "read_file"), "native read_file tool absent");
      call = { index: 0, id: "eng306_read", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: join(home, "project/fixture.txt") }) } };
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    const delta = call ? { role: "assistant", tool_calls: [call] } : { role: "assistant", content: text };
    for (const [value, finish] of [[delta, null], [{}, call ? "tool_calls" : "stop"]]) {
      response.write(`data: ${JSON.stringify({ id: "eng306-fixture", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: value, finish_reason: finish }] })}\n\n`);
    }
    response.end("data: [DONE]\n\n");
  } catch (error) {
    if (failures.length < 8) failures.push(error instanceof Error ? error.message : "fixture failure");
    response.writeHead(400).end("fixture contract failed");
  }
});
server.requestTimeout = 10000;
server.headersTimeout = 10000;
try {
  await new Promise<void>(accept => server.listen(0, "127.0.0.1", accept));
  const address = server.address(); assert(address && typeof address === "object");
  await mkdir(join(home, ".hermes"), { mode: 0o700 });
  await symlink(source, join(home, ".hermes/hermes-agent"));
  await mkdir(join(home, "project"));
  await writeFile(join(home, "project/fixture.txt"), marker, { flag: "wx", mode: 0o600 });
  await writeFile(join(home, ".hermes/config.yaml"), JSON.stringify({
    model: { default: "gpt-4o-mini", provider: "openai-api", base_url: `http://127.0.0.1:${address.port}/v1`, api_mode: "chat_completions", context_length: 128000 },
    agent: { max_turns: 3 }, fallback_providers: [],
    auxiliary: { background_review: { enabled: false }, title_generation: { enabled: false } },
    memory: { memory_enabled: false, user_profile_enabled: false }, security: { allow_lazy_installs: false }, mcp_servers: {},
  }), { flag: "wx", mode: 0o600 });
  // Test-only network guard. Real Hermes code runs; no external DNS/socket is allowed.
  const bootstrap = `import socket, ipaddress, runpy, sys
def allowed(address):
    host = address[0]
    if isinstance(host, bytes): host = host.decode()
    try: ok = host == 'localhost' or ipaddress.ip_address(host).is_loopback
    except ValueError: ok = False
    if not ok:
        print('ENG306_BLOCKED_EXTERNAL_NETWORK', file=sys.stderr)
        raise OSError('Offline fixture network boundary')
connect, connect_ex, lookup = socket.socket.connect, socket.socket.connect_ex, socket.getaddrinfo
def guarded_connect(self, address):
    allowed(address); return connect(self, address)
def guarded_connect_ex(self, address):
    allowed(address); return connect_ex(self, address)
def guarded_lookup(host, port, *args, **kwargs):
    allowed((host, port)); return lookup(host, port, *args, **kwargs)
socket.socket.connect, socket.socket.connect_ex, socket.getaddrinfo = guarded_connect, guarded_connect_ex, guarded_lookup
runpy.run_module('tui_gateway.entry', run_name='__main__')`;
  const environment = {
    HOME: home, MATRIX_HOME: home, HERMES_HOME: join(home, ".hermes"),
    PATH: "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin", PYTHONPATH: source,
    OPENAI_API_KEY: "eng306-loopback-fixture", HERMES_DISABLE_TELEMETRY: "1", HERMES_DISABLE_LAZY_INSTALLS: "1",
    HERMES_IGNORE_RULES: "1", HERMES_SINGLE_QUERY_SESSION: "1", HERMES_TUI_TOOLSETS: "file",
  };
  const spawnFn: HermesGatewaySpawn = (command, args, options) => {
    assert.deepEqual(args, ["-u", "-m", "tui_gateway.entry"]); assert.equal(command, python);
    const child = spawn(command, ["-u", "-c", bootstrap], { ...options, env: environment });
    const index = children.push(child) - 1;
    exits.push(new Promise<void>(accept => child.once("exit", () => accept())));
    let buffered = "";
    let observed = "";
    child.stdout!.on("data", (chunk: Buffer) => {
      observed += chunk.toString(); assert(Buffer.byteLength(observed) <= 256 * 1024);
      let end: number;
      while ((end = observed.indexOf("\n")) >= 0) {
        const frame = JSON.parse(observed.slice(0, end)); observed = observed.slice(end + 1);
        if (frame.params?.type === "message.complete") completedRows.push(frame.params.payload?.persisted_turn ?? null);
      }
    });
    const write = child.stdin!.write.bind(child.stdin!);
    child.stdin!.write = ((chunk: string | Buffer, ...rest: unknown[]) => {
      buffered += chunk.toString(); assert(Buffer.byteLength(buffered) <= 1_048_576);
      let end: number;
      while ((end = buffered.indexOf("\n")) >= 0) {
        const frame = JSON.parse(buffered.slice(0, end)); buffered = buffered.slice(end + 1);
        assert(rpc.length < 100); rpc.push({ child: index, method: frame.method, session: frame.params?.session_id });
      }
      return write(chunk, ...(rest as []));
    }) as typeof child.stdin.write;
    let diagnosticBytes = 0;
    child.stderr!.on("data", (chunk: Buffer) => {
      diagnosticBytes += chunk.length;
      blockedNetworkAttempts += chunk.toString().split("ENG306_BLOCKED_EXTERNAL_NETWORK").length - 1;
      if (diagnosticBytes > 64 * 1024) child.kill("SIGKILL");
    });
    return child;
  };
  const adapter = createHermesChatProviderAdapter({ homePath: home, spawnFn, readyTimeoutMs: 30000, requestTimeoutMs: 30000, timeoutMs: 60000 });
  const controller = new AbortController();
  const input = (text: string, runId: string) => ({
    owner: { type: "personal" as const, ownerId: "eng306-fixture" }, chatId: "chat_eng306", turnId: `cturn_${runId}`, runId: `run_${runId}`,
    prompt: text, parts: [{ type: "text" as const, text }], selection: { instanceId: "hermes_default", model: "openai-api:gpt-4o-mini" },
    interactionMode: "default", permissionMode: "full_access", executionRoot: join(home, "project"), signal: deadline,
  });
  const collect = async (stream: AsyncIterable<CanonicalProviderRunEvent>, outcome: string) => {
    const events: CanonicalProviderRunEvent[] = [];
    for await (const event of stream) events.push(event);
    assert.deepEqual(failures, [], "loopback model contract");
    assert(events.some(event => event.type === "run.completed" && event.outcome === outcome), JSON.stringify(events));
    return events;
  };
  const text = (events: CanonicalProviderRunEvent[]) => events.filter(event => event.type === "assistant.delta").map(event => event.delta).join("");
  const first = await collect(adapter.start(input("ENG306_READ", "first")), "completed");
  assert.equal(text(first), "ENG306 first turn."); assert(toolRoundTrip);
  assert(first.some(event => event.type === "agent.activity" && event.status === "completed"), "native tool activity missing");
  const state = first.find(event => event.type === "state.updated"); assert(state?.type === "state.updated");
  const parsed = adapter.parseState(state.state);
  assert.equal((completedRows[0] as { complete?: boolean } | undefined)?.complete, true, "first turn did not confirm durable persistence");
  const second = await collect(adapter.resume({ ...input("ENG306_RESUME", "second"), resumeState: parsed }), "completed");
  assert.equal(text(second), "ENG306 continued turn."); assert(resumedHistory);
  assert(rpc.some(call => call.child === 1 && call.method === "session.resume" && call.session === parsed.sessionId));
  const cancelled = collect(adapter.start({ ...input("ENG306_CANCEL", "cancel"), signal: AbortSignal.any([deadline, controller.signal]) }), "aborted");
  await Promise.race([held, cancelled.then(() => { throw new Error("Cancelled before fixture inference"); })]);
  controller.abort(); await cancelled;
  assert(rpc.some(call => call.child === 2 && call.method === "session.interrupt"), "cancellation skipped native interrupt");
  assert.equal(children.length, 3); assert.equal(requests, 4);
  await Promise.all(exits);
  assert(children.every(child => child.exitCode !== null || child.signalCode !== null));
  console.log(JSON.stringify({ source: "e06df9c2eae6901f4c88f464e0ae6e753c0428b8", python: version.stdout.trim(), interpreter: python,
    sdkPreflight: "openai 2.24.0 + anthropic 0.87.0", streaming: "pass", coldResumeHistory: "pass", builtinReadTool: "pass", cancellation: "pass", cleanup: "3 native children exited",
    loopbackRequests: requests, networkBoundary: "test-only DNS/socket loopback guard", blockedNetworkAttempts, realCredentialsLoaded: false,
    mcp: sdk.stdout.trim() === "missing" ? { status: "blocked", reason: "mcp==2.0.0 absent in existing isolated environment; no installation attempted" } : { status: "not tested" },
  }, null, 2));
} finally {
  cancelResponse?.destroy();
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  await Promise.all(exits);
  server.closeAllConnections();
  if (server.listening) await new Promise<void>((accept, reject) => server.close(error => error ? reject(error) : accept()));
  await rm(home, { recursive: true, force: true });
}
