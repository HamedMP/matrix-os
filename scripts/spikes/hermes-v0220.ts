/** Existing official runtime only: node --import=tsx scripts/spikes/hermes-v0220.ts /tmp/eng306-runtime */
import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createServer, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
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
// Optional task-owned SDK overlay; never changes PM facts or the selected runtime.
const mcpPython = process.argv[3] ? await realpath(process.argv[3]) : undefined;
if (mcpPython) assert.equal(mcpPython, await realpath("/tmp/eng306-mcp-fixture-venv/bin/python"));
const childPython = mcpPython ? "/tmp/eng306-mcp-fixture-venv/bin/python" : python;
const failSpawn = process.argv[4] === "--test-spawn-failure";
const run = promisify(execFile);
const version = await run(python, ["--version"], { timeout: 5000, env: { PATH: "/usr/bin:/bin" } });
const sdk = await run(python, ["-I", "-c", "import importlib.util; print('present' if importlib.util.find_spec('mcp') else 'missing')"], { timeout: 10000, env: { PATH: "/usr/bin:/bin" } });
const home = await mkdtemp(join(tmpdir(), "eng306-native-fixture-"));
const children: ChildProcess[] = [];
const exits: Promise<void>[] = [];
const rpc: { child: number; method: string; session?: string }[] = [];
const failures: string[] = [];
const completedRows: unknown[] = [];
const diagnostics: string[] = [];
let blockedNetworkAttempts = 0;
let requests = 0;
let toolRoundTrip = false;
let resumedHistory = false;
let mcpRoundTrip = false;
let cancelResponse: ServerResponse | undefined;
let acceptHeld!: () => void;
const held = new Promise<void>(accept => { acceptHeld = accept; });
const marker = "ENG306_SYNTHETIC_FILE_CONTENT";
const mcpLog = join(home, "mcp-events.jsonl");
const mcpTool = "mcp__eng306__echo";
const server = createServer(async (request, response) => {
  try {
    const chunks: Buffer[] = []; let bytes = 0;
    for await (const chunk of request) { bytes += chunk.length; assert(bytes <= 1_048_576); chunks.push(chunk); }
    assert(request.method === "POST" && request.url === "/v1/chat/completions", "unexpected fixture endpoint");
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    assert.equal(body.model, "gpt-4o-mini"); assert(++requests <= (mcpPython ? 5 : 4), "unexpected auxiliary/retry inference");
    const messages = body.messages as { role: string; content: unknown }[];
    const mcpCall = (id: string, value: string) => {
      const names = body.tools?.map((tool: { function?: { name?: string } }) => tool.function?.name) as string[];
      assert(names?.includes(mcpTool) || names?.includes("tool_call"), `MCP invocation surface missing: ${JSON.stringify(names)}`);
      return { index: 0, id, type: "function", function: names.includes(mcpTool)
        ? { name: mcpTool, arguments: JSON.stringify({ value }) }
        : { name: "tool_call", arguments: JSON.stringify({ calls: [{ name: mcpTool, arguments: { value } }] }) } };
    };
    const lastUser = JSON.stringify(messages.filter(message => message.role === "user").at(-1)?.content);
    let text = ""; let call: object | undefined;
    if (lastUser.includes("ENG306_CANCEL") && mcpPython) {
      call = mcpCall("eng306_hold", "hold");
    } else if (lastUser.includes("ENG306_CANCEL")) {
      cancelResponse = response;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({ id: "held", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: { role: "assistant", content: "held" }, finish_reason: null }] })}\n\n`);
      acceptHeld(); return;
    } else if (lastUser.includes("ENG306_RESUME")) {
      assert(messages.some(message => message.role === "assistant" && JSON.stringify(message.content).includes("ENG306 first turn.")), "resume lost the first assistant message");
      assert(messages.some(message => message.role === "tool" && JSON.stringify(message.content).includes(marker)), "resume lost the genuine tool result");
      if (mcpPython) assert(messages.some(message => message.role === "tool" && JSON.stringify(message.content).includes("ENG306_REAL_MCP_RESULT")), "resume lost the real MCP result");
      resumedHistory = true; text = "ENG306 continued turn.";
    } else if (mcpPython && messages.some(message => message.role === "tool" && JSON.stringify(message.content).includes("ENG306_REAL_MCP_RESULT"))) {
      mcpRoundTrip = true; text = "ENG306 first turn.";
    } else if (messages.some(message => message.role === "tool" && JSON.stringify(message.content).includes(marker))) {
      toolRoundTrip = true;
      if (mcpPython) {
        call = mcpCall("eng306_echo", "eng306");
      } else text = "ENG306 first turn.";
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
const mcpEvents = async () => {
  const raw = await readFile(mcpLog, "utf8"); assert(Buffer.byteLength(raw) <= 65536);
  return raw.trim().split("\n").map(line => JSON.parse(line) as { kind: string; pid: number; method?: string; value?: string });
};
const waitMcpExit = async (events: Awaited<ReturnType<typeof mcpEvents>>) => {
  for (const pid of new Set(events.filter(event => event.kind === "started").map(event => event.pid))) {
    const started = Date.now();
    while (true) {
      try { process.kill(pid, 0); }
      catch (error) { assert.equal((error as NodeJS.ErrnoException).code, "ESRCH"); break; }
      assert(Date.now() - started < 5000, "MCP child still alive after bounded cleanup");
      await new Promise(accept => setTimeout(accept, 50));
    }
  }
};
const waitNativeExit = async () => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([Promise.all(exits), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Native fixture cleanup unconfirmed")), 5000); })]); }
  finally { if (timer) clearTimeout(timer); }
};
try {
  await new Promise<void>(accept => server.listen(0, "127.0.0.1", accept));
  const address = server.address(); assert(address && typeof address === "object");
  await mkdir(join(home, ".hermes"), { mode: 0o700 });
  await symlink(source, join(home, ".hermes/hermes-agent"));
  await mkdir(join(home, "project"));
  await writeFile(join(home, "project/fixture.txt"), marker, { flag: "wx", mode: 0o600 });
  await writeFile(join(home, ".hermes/config.yaml"), JSON.stringify({
    model: { default: "gpt-4o-mini", provider: "openai-api", base_url: `http://127.0.0.1:${address.port}/v1`, api_mode: "chat_completions", context_length: 128000 },
    agent: { max_turns: 4 }, fallback_providers: [],
    auxiliary: { background_review: { enabled: false }, title_generation: { enabled: false } },
    memory: { memory_enabled: false, user_profile_enabled: false }, security: { allow_lazy_installs: false },
    mcp_servers: mcpPython ? { eng306: { command: childPython, args: [join(process.cwd(), "scripts/spikes/fixtures/hermes-mcp-server.py"), mcpLog], timeout: 30 } } : {},
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
    HERMES_IGNORE_RULES: "1", HERMES_SINGLE_QUERY_SESSION: "1", HERMES_TUI_TOOLSETS: mcpPython ? "file,eng306" : "file",
  };
  const spawnFn: HermesGatewaySpawn = (command, args, options) => {
    assert.deepEqual(args, ["-u", "-m", "tui_gateway.entry"]); assert.equal(command, python);
    if (failSpawn) console.error("ENG306_SYNTHETIC_SPAWN_FAILURE_INJECTED");
    const child = spawn(failSpawn ? join(home, "missing-python") : childPython, ["-u", "-c", bootstrap], { ...options, env: environment });
    const index = children.push(child) - 1;
    diagnostics[index] = "";
    // Failed spawns emit error + close without exit. Close also proves pipe drain.
    exits.push(new Promise<void>(accept => child.once("close", () => accept())));
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
      if (diagnosticBytes <= 64 * 1024) diagnostics[index] += chunk.toString();
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
  if (mcpPython) assert(mcpRoundTrip, "real MCP result did not reach the model");
  assert(first.some(event => event.type === "agent.activity" && event.status === "completed"), "native tool activity missing");
  const state = first.find(event => event.type === "state.updated"); assert(state?.type === "state.updated");
  const parsed = adapter.parseState(state.state);
  assert.equal((completedRows[0] as { complete?: boolean } | undefined)?.complete, true, "first turn did not confirm durable persistence");
  const second = await collect(adapter.resume({ ...input("ENG306_RESUME", "second"), resumeState: parsed }), "completed");
  assert.equal(text(second), "ENG306 continued turn."); assert(resumedHistory);
  assert(rpc.some(call => call.child === 1 && call.method === "session.resume" && call.session === parsed.sessionId));
  const cancelled = collect(adapter.start({ ...input("ENG306_CANCEL", "cancel"), signal: AbortSignal.any([deadline, controller.signal]) }), "aborted");
  if (mcpPython) {
    await Promise.race([(async () => {
      const started = Date.now();
      while (!(await mcpEvents()).some(event => event.kind === "tool_call" && event.value === "hold")) {
        assert(Date.now() - started < 30000, "real MCP hold call did not start"); deadline.throwIfAborted();
        await new Promise(accept => setTimeout(accept, 50));
      }
    })(), cancelled.then(() => { throw new Error("Cancelled before native MCP hold call"); })]);
  } else await Promise.race([held, cancelled.then(() => { throw new Error("Cancelled before fixture inference"); })]);
  controller.abort(); await cancelled;
  assert(rpc.some(call => call.child === 2 && call.method === "session.interrupt"), "cancellation skipped native interrupt");
  assert.equal(children.length, 3); assert.equal(requests, mcpPython ? 5 : 4);
  await waitNativeExit();
  assert(children.every(child => child.exitCode !== null || child.signalCode !== null));
  let mcpEvidence = mcpPython ? await mcpEvents() : [];
  if (mcpPython) {
    assert(mcpEvidence.some(event => event.method === "initialize"));
    assert(mcpEvidence.some(event => event.method === "tools/list"));
    assert(mcpEvidence.some(event => event.value === "eng306"));
    assert(mcpEvidence.some(event => event.method === "notifications/cancelled"), "real MCP cancellation notification missing");
    await waitMcpExit(mcpEvidence);
    mcpEvidence = await mcpEvents();
  }
  console.log(JSON.stringify({ source: "e06df9c2eae6901f4c88f464e0ae6e753c0428b8", python: version.stdout.trim(), interpreter: python,
    sdkPreflight: "openai 2.24.0 + anthropic 0.87.0", streaming: "pass", coldResumeHistory: "pass", builtinReadTool: "pass", cancellation: "pass", cleanup: "3 native children exited",
    loopbackRequests: requests, networkBoundary: "test-only DNS/socket loopback guard", blockedNetworkAttempts, realCredentialsLoaded: false,
    mcp: mcpPython ? { status: "pass", interpreter: childPython, sdk: "2.0.0", discoveryCallResult: true, heldToolCancellation: true, childCleanup: true, events: mcpEvidence } : sdk.stdout.trim() === "missing" ? { status: "blocked", reason: "mcp==2.0.0 absent in selected PM generation" } : { status: "not tested" },
  }, null, 2));
} catch (error) {
  let mcpEvents: string | undefined;
  try { mcpEvents = (await readFile(mcpLog, "utf8")).slice(0, 65536); }
  catch (readError) { mcpEvents = readError instanceof Error ? readError.name : "unavailable"; }
  console.error(JSON.stringify({ diagnostics, mcpEvents }));
  throw error;
} finally {
  cancelResponse?.destroy();
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  try {
    await waitNativeExit();
    if (mcpPython) {
      try { await waitMcpExit(await mcpEvents()); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
  } finally {
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((accept, reject) => server.close(error => error ? reject(error) : accept()));
    await rm(home, { recursive: true, force: true });
  }
}
