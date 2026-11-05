import { randomUUID } from "node:crypto";
import { chmod, link, lstat, mkdtemp, rmdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createConnection, createServer } from "node:net";
import { assert, must, NODE, noSymlinkAncestors, stat, waitFor } from "./control.mjs";

export function assertDrained(state) { assert(state.split("\n").includes("ActiveState=inactive"), "worker_not_drained"); }
export const MODEL = "claude-haiku-4-5-20251001";
export function supervisorArgs(config, token, template) {
  const properties = []; let service = false;
  for (const line of template.split("\n")) {
    if (line.startsWith("[")) { service = line === "[Service]"; continue; }
    if (!service || !/^[A-Za-z]+=/.test(line) || line.startsWith("ExecStart=")) continue;
    let property = line;
    if (/^(RuntimeDirectory|StateDirectory)=/.test(line)) property = `${line.split("=")[0]}=matrix-devstack/${config.namespace}/scope-runtime`;
    if (line.startsWith("RuntimeDirectory=")) property += ` matrix-devstack/${config.namespace}/c`;
    if (line.startsWith("BindReadOnlyPaths=")) property = line.replace("/home/matrix/home", config.home ?? `${config.appRoot.slice(0, -4)}/home`);
    properties.push(`--property=${property}`);
  }
  assert(properties.includes("--property=ProtectSystem=strict") && properties.includes("--property=PrivateNetwork=yes"), "supervisor_template_invalid");
  return ["--quiet", `--unit=${config.supervisorUnit}`, `--description=${token}`, ...properties,
    `--property=ReadWritePaths=${config.runtimeDirectory} ${config.commandSocketRoot}`,
    "--property=RuntimeMaxSec=180", `--setenv=MATRIX_SCOPE_RUNTIME_NAMESPACE=${config.namespace}`,
    `--setenv=MATRIX_SCOPE_RUNTIME_APP_ROOT=${config.appRoot}`, `--setenv=MATRIX_HOME=${config.home ?? `${config.appRoot.slice(0, -4)}/home`}`,
    "--", "/usr/bin/env", "-i", `PATH=/opt/matrix/runtime/node/bin:/usr/bin:/bin`,
    `MATRIX_SCOPE_RUNTIME_NAMESPACE=${config.namespace}`, `MATRIX_SCOPE_RUNTIME_APP_ROOT=${config.appRoot}`,
    `MATRIX_HOME=${config.home ?? `${config.appRoot.slice(0, -4)}/home`}`, "NOTIFY_SOCKET=/run/systemd/notify", "WATCHDOG_USEC=60000000", NODE, `${config.appRoot}/packages/scope-runtime/dist/main.js`];
}
export function exchange(path, frame, timeout = 10_000) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path }); let response = Buffer.alloc(0); let settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(deadline); socket.destroy(); error ? reject(error) : resolve(value); };
    const deadline = setTimeout(() => finish(new Error("socket_timeout")), timeout);
    socket.setTimeout(timeout, () => finish(new Error("socket_timeout")));
    socket.once("connect", () => socket.end(`${JSON.stringify(frame)}\n`));
    socket.on("data", chunk => {
      if (response.length + chunk.length > 512 * 1024) return finish(new Error("socket_capacity"));
      response = Buffer.concat([response, chunk]);
      const newline = response.indexOf(10); if (newline < 0) return;
      try { finish(undefined, JSON.parse(response.subarray(0, newline).toString("utf8"))); }
      catch (error) { finish(error instanceof SyntaxError ? new Error("socket_reply_invalid") : error); }
    });
    socket.once("error", () => finish(new Error("socket_unavailable")));
    socket.once("close", () => finish(new Error("socket_closed")));
  });
}
function providerResponse() {
  const event = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  return event("message_start", { message: { id: "msg_native_proof", type: "message", role: "assistant", model: MODEL,
    content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 } } })
    + event("content_block_start", { index: 0, content_block: { type: "text", text: "" } })
    + event("content_block_delta", { index: 0, delta: { type: "text_delta", text: "scope-sdk-ok" } })
    + event("content_block_stop", { index: 0 })
    + event("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } })
    + event("message_stop", {});
}
export async function startBroker(path, bindingParent = dirname(path)) {
  assert(!await stat(path), "broker_collision"); let requests = 0; const sockets = new Set();
  const server = createServer({ allowHalfOpen: true }, socket => {
    if (sockets.size >= 16) { socket.destroy(); return; } sockets.add(socket);
    const deadline = setTimeout(() => socket.destroy(), 5000);
    socket.once("close", () => { clearTimeout(deadline); sockets.delete(socket); }); socket.on("error", () => socket.destroy());
    let input = Buffer.alloc(0); let settled = false;
    const reply = value => { if (settled) return; settled = true; socket.end(`${JSON.stringify(value)}\n`); };
    socket.setTimeout(5000, () => socket.destroy());
    socket.on("data", chunk => {
      if (settled) return;
      if (input.length + chunk.length > 512 * 1024) { socket.destroy(); return; }
      input = Buffer.concat([input, chunk]); if (!input.includes(10)) return;
      let request; try { request = JSON.parse(input.subarray(0, input.indexOf(10)).toString("utf8")); }
      catch (error) { if (!(error instanceof SyntaxError)) throw error; reply({ ok: false, error: "invalid_request" }); return; }
      const base = { version: 1, requestId: request.requestId };
      if (request.version !== 1 || request.action !== "inference.messages") { reply({ ...base, ok: false, error: "action_denied" }); return; }
      if (request.method === "HEAD" && request.path === "/api/hello") { reply({ ...base, ok: true, status: 200, headers: {}, body: "" }); return; }
      let body; try { body = JSON.parse(request.body); } catch (error) { if (!(error instanceof SyntaxError)) throw error; }
      if (request.method !== "POST" || request.path !== "/v1/messages?beta=true"
        || typeof request.body !== "string" || Buffer.byteLength(request.body) > 256 * 1024
        || body?.model !== MODEL || !Array.isArray(body.messages)) { reply({ ...base, ok: false, error: "route_denied" }); return; }
      requests++; reply({ ...base, ok: true, status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-cache" }, body: providerResponse() });
    });
  });
  const parent = await lstat(bindingParent);
  assert(parent.isDirectory() && !parent.isSymbolicLink() && parent.uid === process.getuid() && (parent.mode & 0o022) === 0, "broker_bind_parent_unprotected");
  const privateDirectory = await mkdtemp(join(bindingParent, ".b-"));
  const privateOwner = await lstat(privateDirectory); const bindPath = join(privateDirectory, "s");
  const removePrivate = async () => {
    const current = await lstat(privateDirectory);
    assert(current.ino === privateOwner.ino && current.dev === privateOwner.dev, "broker_private_ownership_lost");
    await rmdir(privateDirectory);
  };
  let owned;
  try {
    assert(Buffer.byteLength(bindPath) <= 107, "broker_bind_path_capacity");
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(bindPath, resolve); });
    owned = await lstat(bindPath); await chmod(bindPath, 0o666);
    // Same-filesystem exclusive publication. Node may unlink only its protected
    // private bind path; it never owns the externally visible pathname.
    await link(bindPath, path);
  } catch (error) {
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await removePrivate(); throw error;
  }
  let closing;
  return { requests: () => requests, close() {
    return closing ??= (async () => {
      for (const socket of sockets) socket.destroy();
      try {
        await new Promise(resolve => server.close(resolve));
        const current = await stat(path);
        assert(current?.ino === owned.ino && current.dev === owned.dev, "broker_cleanup_ownership_lost");
        await unlink(path);
      } finally { await removePrivate(); }
    })();
  } };
}

export async function supervisorRequest(config, type, payload = {}) {
  const reply = await exchange(config.supervisorSocket, { version: 1, type, requestId: randomUUID(), ...payload }, type === "capability.get" ? 5000 : 60_000);
  assert(reply.ok === true, "supervisor_request_failed"); return reply;
}
export async function nativeProof(config, identity, inspect) {
  const capability = () => supervisorRequest(config, "capability.get");
  const before = await waitFor(async () => { if (!(await stat(config.supervisorSocket))?.isSocket()) return false;
    return capability(); }, "supervisor_not_ready");
  await noSymlinkAncestors(dirname(config.runtimeDirectory), true);
  let broker = await startBroker(config.brokerSocket, dirname(config.runtimeDirectory));
  const create = async profile => {
    const adapter = profile.adapters.find(item => item.adapterId === "claude-code"); assert(adapter, "native_adapter_missing");
    const reply = await supervisorRequest(config, "runtime.create", { scopeHandle: `scope_${randomUUID().replaceAll("-", "")}`,
      profileId: profile.profileId, workload: "chat_ai", adapterId: adapter.adapterId, harnessVersion: adapter.harnessVersion });
    assert(reply.state === "running" && identity.parseWorkerUnit(identity.workerUnit(reply.runtimeHandle)) === reply.runtimeHandle, "runtime_invalid"); return reply.runtimeHandle;
  };
  try {
    const first = await create(before.profile); const firstUnit = identity.workerUnit(first);
    const boundary = await inspect(firstUnit);
    const sdk = await supervisorRequest(config, "runtime.chat", { runtimeHandle: first, executionGeneration: before.profile.executionGeneration,
      model: MODEL, prompt: "Return the bounded acceptance response." });
    assert(sdk.type === "runtime.chat.result" && sdk.text === "scope-sdk-ok" && broker.requests() > 0, "actual_sdk_result_missing");
    const denied = await exchange(config.brokerSocket, { version: 1, requestId: randomUUID(), action: "host.fetch" });
    assert(denied.ok === false && denied.error === "action_denied", "broker_action_boundary_failed");
    await must("/usr/bin/systemctl", ["kill", "--kill-whom=main", "--signal=SIGKILL", config.supervisorUnit], "own_crash_failed");
    const previousBroker = broker; broker = undefined; await previousBroker.close();
    const after = await waitFor(async () => {
      try { const reply = await capability(); return reply.profile.executionGeneration !== before.profile.executionGeneration && reply; }
      catch (error) { if (["socket_unavailable", "socket_closed", "supervisor_request_failed"].includes(error.message)) return false; throw error; }
    }, "own_restart_failed");
    await must("/usr/bin/systemctl", ["is-active", "--quiet", firstUnit], "reconciliation_failed");
    const reconciledPid = await must("/usr/bin/systemctl", ["show", firstUnit, "--property=MainPID", "--value"], "reconciled_pid_unavailable");
    assert(reconciledPid === boundary.properties.MainPID, "reconciled_worker_changed");
    const stopped = await supervisorRequest(config, "runtime.stop", { runtimeHandle: first });
    assert(stopped.state === "stopped", "runtime_stop_failed");
    broker = await startBroker(config.brokerSocket, dirname(config.runtimeDirectory)); const second = await create(after.profile);
    await must("/usr/bin/systemctl", ["stop", config.supervisorUnit], "own_drain_failed", 55_000);
    await waitFor(async () => !await stat(config.supervisorSocket), "socket_not_drained");
    const secondState = await must("/usr/bin/systemctl", ["show", identity.workerUnit(second), "--property=ActiveState"], "drain_state_unavailable");
    assertDrained(secondState);
    return { sdk: { result: sdk.text, type: sdk.type, transport: "unix_socket_fake_broker", providerCall: false }, boundary,
      capability: before, generationAfter: after.profile.executionGeneration, recovery: { restart: true, reconcile: true, drain: true, brokerActionDenied: true } };
  } finally { if (broker) await broker.close(); }
}
