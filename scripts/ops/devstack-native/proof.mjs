import { beginCloseEvidence, stderrPath, STDERR_LIMIT } from "./close-evidence.mjs";
import { inspectCommandCleanup } from "./ipc-evidence.mjs";
import { assertStableProcess, assertStableUnit } from "./credential-evidence.mjs";
import { CODEX_BINARY } from "./security.mjs";
import { safeCapability } from "./receipt.mjs";
import { startControls } from "./controls.mjs";
import { inspectWorker, inspectWorkerConfiguration, inspectWorkerPair, inspectSupervisor } from "./evidence.mjs";
import { exclusiveDirectory } from "./placement.mjs";
import { randomUUID } from "node:crypto";
import { chmod, link, lstat, mkdtemp, rmdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createConnection, createServer } from "node:net";
import { assert, must, noSymlinkAncestors, stat, waitFor } from "./control.mjs";

export function assertDrained(state) { assert(state.split("\n").includes("ActiveState=inactive"), "worker_not_drained"); }
export async function qualifyGracefulDrain(config, ledger, handle, io = {}) {
  await ledger.supervisorAction("stop", io.beginClose ?? ((owner, handles) => beginCloseEvidence(config, io.capture, owner, handles)));
  const socketAbsent = io.socketAbsent ?? (async () => !await stat(config.supervisorSocket));
  return ledger.waitForGracefulDrain(handle, socketAbsent, io.timeout);
}
export const MODEL = "claude-haiku-4-5-20251001";
export function supervisorArgs(config, token, template) {
  const properties = []; let service = false;
  for (const line of template.split("\n")) {
    if (line.startsWith("[")) { service = line === "[Service]"; continue; }
    if (!service || !/^[A-Za-z]+=/.test(line) || line.startsWith("ExecStart=")) continue;
    let property = line;
    if (/^(RuntimeDirectory|StateDirectory)=/.test(line)) property = `${line.split("=")[0]}=matrix-devstack/${config.namespace}/scope-runtime`;
    if (line.startsWith("RuntimeDirectoryMode=")) property = "RuntimeDirectoryMode=0700";
    if (line.startsWith("RuntimeDirectory=")) property += ` matrix-devstack/${config.namespace}/c`;
    if (line.startsWith("BindReadOnlyPaths=")) property = line.replace("/home/matrix/home", config.home ?? `${config.appRoot.slice(0, -4)}/home`);
    properties.push(`--property=${property}`);
  }
  assert(properties.includes("--property=ProtectSystem=strict") && properties.includes("--property=PrivateNetwork=yes"), "supervisor_template_invalid");
  return ["--quiet", `--unit=${config.supervisorUnit}`, `--description=${token}`, ...properties,
    `--property=ReadWritePaths=${config.runtimeDirectory} ${config.commandSocketRoot}`,
    `--property=InaccessiblePaths=-${CODEX_BINARY}`,
    `--property=StandardError=append:${stderrPath(config, token)}`, `--property=LimitFSIZE=${STDERR_LIMIT}`,
    "--property=RuntimeMaxSec=180", "--property=KillSignal=SIGKILL", "--property=RemainAfterExit=yes", `--setenv=MATRIX_SCOPE_RUNTIME_NAMESPACE=${config.namespace}`,
    `--setenv=MATRIX_SCOPE_RUNTIME_NODE_ROOT=${config.ownedNode.root}`,
    `--setenv=MATRIX_SCOPE_RUNTIME_APP_ROOT=${config.appRoot}`, `--setenv=MATRIX_HOME=${config.home ?? `${config.appRoot.slice(0, -4)}/home`}`,
    "--", "/usr/bin/env", "-i", `PATH=${config.ownedNode.root}/bin:/usr/bin:/bin`,
    `MATRIX_SCOPE_RUNTIME_NODE_ROOT=${config.ownedNode.root}`,
    `MATRIX_SCOPE_RUNTIME_NAMESPACE=${config.namespace}`, `MATRIX_SCOPE_RUNTIME_APP_ROOT=${config.appRoot}`,
    `MATRIX_HOME=${config.home ?? `${config.appRoot.slice(0, -4)}/home`}`, "NOTIFY_SOCKET=/run/systemd/notify", "WATCHDOG_USEC=60000000", config.ownedNode.binary, "--import", `${config.appRoot}/scripts/ops/devstack-native/codex-mask-preload.mjs`, `${config.appRoot}/packages/scope-runtime/dist/main.js`];
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
export async function startBroker(path, bindingParent = dirname(path), check = () => {}) {
  const parent = await lstat(bindingParent);
  assert(parent.isDirectory() && !parent.isSymbolicLink() && parent.uid === process.getuid() && (parent.mode & 0o022) === 0, "broker_bind_parent_unprotected");
  const publication = await exclusiveDirectory(dirname(path), check);
  try { await publication.verify(); assert(!await stat(path), "broker_collision"); } catch (error) { await publication.close(); throw error; }
  let requests = 0; const sockets = new Set();
  const server = createServer({ allowHalfOpen: true }, socket => {
    if (sockets.size >= 16) { socket.destroy(); return; } sockets.add(socket);
    const deadline = setTimeout(() => socket.destroy(), 5000);
    socket.once("close", () => { clearTimeout(deadline); sockets.delete(socket); }); socket.on("error", () => socket.destroy());
    let input = Buffer.alloc(0); let settled = false;
    const reply = value => { if (settled) return; settled = true; socket.end(`${JSON.stringify(value)}\n`); };
    socket.setTimeout(5000, () => socket.destroy());
    socket.on("data", chunk => {
      try {
      if (settled) return;
      if (input.length + chunk.length > 512 * 1024) { socket.destroy(); return; }
      input = Buffer.concat([input, chunk]); if (!input.includes(10)) return;
      let request; try { request = JSON.parse(input.subarray(0, input.indexOf(10)).toString("utf8")); }
      catch (error) { if (!(error instanceof SyntaxError)) throw error; reply({ ok: false, error: "invalid_request" }); return; }
      if (!request || typeof request !== "object" || Array.isArray(request)) { reply({ ok: false, error: "invalid_request" }); return; }
      const base = { version: 1, requestId: typeof request.requestId === "string" && request.requestId.length <= 64 ? request.requestId : "invalid" };
      if (request.version !== 1 || request.action !== "inference.messages") { reply({ ...base, ok: false, error: "action_denied" }); return; }
      if (request.method === "HEAD" && request.path === "/api/hello") { reply({ ...base, ok: true, status: 200, headers: {}, body: "" }); return; }
      let body; try { body = JSON.parse(request.body); } catch (error) { if (!(error instanceof SyntaxError)) throw error; }
      if (request.method !== "POST" || request.path !== "/v1/messages?beta=true"
        || typeof request.body !== "string" || Buffer.byteLength(request.body) > 256 * 1024
        || body?.model !== MODEL || !Array.isArray(body.messages)) { reply({ ...base, ok: false, error: "route_denied" }); return; }
      requests++; reply({ ...base, ok: true, status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-cache" }, body: providerResponse() });
      } catch (error) { reply({ ok: false, error: "invalid_request" }); }
    });
  });
  let privateDirectory, privateOwner;
  try { check(); privateDirectory = await mkdtemp(join(bindingParent, ".b-")); privateOwner = await lstat(privateDirectory); }
  catch (error) { await publication.close(); throw error; }
  const bindPath = join(privateDirectory, "s");
  const removePrivate = async () => {
    const current = await lstat(privateDirectory);
    assert(current.ino === privateOwner.ino && current.dev === privateOwner.dev, "broker_private_ownership_lost");
    await rmdir(privateDirectory);
  };
  let owned;
  try {
    check();
    assert(Buffer.byteLength(bindPath) <= 107, "broker_bind_path_capacity");
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(bindPath, resolve); });
    owned = await lstat(bindPath); check(); await chmod(bindPath, 0o666);
    // Same-filesystem exclusive publication. Node may unlink only its protected
    // private bind path; it never owns the externally visible pathname.
    await publication.verify(); check(); await link(bindPath, path);
  } catch (error) {
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await removePrivate(); await publication.close(); throw error;
  }
  let closing;
  return { requests: () => requests, close() {
    return closing ??= (async () => {
      for (const socket of sockets) socket.destroy();
      try {
        await new Promise(resolve => server.close(resolve));
        await removePublishedSocket(path, owned, publication);
      } finally { try { await removePrivate(); } finally { await publication.close(); } }
    })();
  } };
}

export async function removePublishedSocket(path, owned, publication, io = { stat, unlink }) {
  await publication.verify(); const current = await io.stat(path);
  assert(current?.ino === owned.ino && current.dev === owned.dev, "broker_cleanup_ownership_lost");
  // No other UID/group may write this pinned directory. Recheck permission and
  // directory identity after the awaited pathname read, immediately before unlink.
  await publication.verify(); await io.unlink(path);
}

export async function supervisorRequest(config, type, payload = {}) {
  const requestId = randomUUID();
  const reply = await exchange(config.supervisorSocket, { version: 1, type, requestId, ...payload }, type === "capability.get" ? 5000 : 60_000);
  const expected = { "capability.get": "capability.result", "runtime.create": "runtime.result", "runtime.stop": "runtime.result", "runtime.chat": "runtime.chat.result" }[type];
  assert(reply?.version === 1 && reply.requestId === requestId && reply.type === expected && reply.ok === true, "supervisor_request_failed"); return reply;
}
export async function observeWorkers(config) {
  const text = await must("/usr/bin/systemctl", ["list-units", "--all", "--no-legend", "--plain", `${config.workerUnitPrefix}*.service`], "worker_observation_failed");
  const names = text.split("\n").map(line => line.trim().split(/\s+/)[0]).filter(Boolean);
  assert(names.length <= 64, "worker_observation_capacity"); return names;
}
export async function createTrackedWorker(config, profile, ledger, assertInventory, { request = supervisorRequest, inventory = observeWorkers, check = () => {} } = {}) {
  await ledger.freshSupervisor(); await assertInventory(); const scopeHandle = `scope_${randomUUID().replaceAll("-", "")}`;
  check();
  let reply;
  try {
    reply = await request(config, "runtime.create", { scopeHandle, profileId: profile.profileId, workload: "chat_ai", adapterId: "claude-code", harnessVersion: profile.adapter.harnessVersion });
    assert(reply.state === "running" && reply.executionGeneration === profile.executionGeneration, "runtime_invalid");
    await ledger.recordWorker(reply);
  } catch (error) { ledger.partialCreate(scopeHandle, error); ledger.inventory(await inventory(config)); throw error; }
  check(); // The submitted create is now conclusively recorded.
  return reply;
}
export async function nativeProof(config, identity, context, io = {}) {
  const { request = supervisorRequest, inventory = observeWorkers, workerConfiguration = inspectWorkerConfiguration,
    supervisorConfiguration = inspectSupervisor, workerIsolation = inspectWorker, brokerStart = startBroker,
    controlsStart = startControls, brokerExchange = exchange, gracefulDrain = qualifyGracefulDrain, commandCleanup = inspectCommandCleanup, socketStat = stat } = io;
  const { journal, ledger, dependencies, baseline, expectedProfile, node, check } = context;
  const capability = async () => {
    check();
    const safe = safeCapability(await request(config, "capability.get"));
    assert(safe.profileDigest === expectedProfile.profileDigest && safe.adapter.harnessVersion === dependencies.sdk.claudeCodeVersion, "source_profile_mismatch"); return safe;
  };
  const assertInventory = async () => assert(ledger.inventory(await inventory(config)).length === 0, "unowned_worker_quarantined");
  const create = async (profile, role) => {
    const reply = await createTrackedWorker(config, profile, ledger, assertInventory, { check, request, inventory });
    const configuration = await journal.resourceStep(reply.runtimeHandle, role, () => workerConfiguration(config, reply.runtimeHandle, dependencies, identity.workerUnit(reply.runtimeHandle), node));
    return { handle: reply.runtimeHandle, configuration };
  };
  let broker, controls;
  try {
    const before = await journal.step("capability", async () => waitFor(async () => {
      if (!(await socketStat(config.supervisorSocket))?.isSocket()) return false; return capability();
    }, "supervisor_not_ready"));
    await journal.step("supervisor_security", () => supervisorConfiguration(config, node));
    check();
    broker = await brokerStart(config.brokerSocket, dirname(config.runtimeDirectory), check);
    const { handle: first } = await create(before, "isolation_control"), { handle: peer } = await create(before, "peer_control");
    const peerSockets = [first, peer].map(handle => `${config.commandSocketRoot}/${handle.slice(8)}/worker.sock`);
    await journal.step("isolation", async () => {
      const pair = await inspectWorkerPair(ledger, [first, peer], handle =>
        workerConfiguration(config, handle, dependencies, identity.workerUnit(handle), node));
      check();
      controls = await controlsStart(config, baseline, peerSockets, check);
      check();
      const current = await ledger.freshWorker(first);
      assert(current.MainPID === pair[0].properties.MainPID, "worker_pair_pid_changed");
      check();
      const isolation = await workerIsolation(pair[0], controls, node);
      await ledger.freshWorker(first); // Recheck the recorded incarnation across the namespace probe.
      return { ...isolation, pair: pair.map(({ handle, invocationId, properties, namespaces, rootIdentity, cgroup }) =>
        ({ handle, invocationId, pid: Number(properties.MainPID), namespaces, rootIdentity, cgroup })) };
    });
    // The positive controls above consume both command slots. Never reconnect
    // either one: qualify a fresh SDK worker against the existing control targets.
    const { handle: sdkHandle, configuration: sdkConfiguration } = await create(before, "sdk");
    await journal.step("sdk_isolation", async () => {
      const current = await ledger.freshWorker(sdkHandle);
      assert(current.ActiveState === "active" && current.SubState === "running", "worker_sdk_not_live");
      assert(current.MainPID === sdkConfiguration.properties.MainPID, "worker_sdk_pid_changed");
      check();
      const isolation = await workerIsolation(sdkConfiguration, controls, node);
      const afterProbe = await ledger.freshWorker(sdkHandle);
      assert(afterProbe.ActiveState === "active" && afterProbe.SubState === "running", "worker_sdk_not_live");
      return { ...isolation, handle: sdkHandle, invocationId: current.InvocationID, commandSocketUntouchedByHostControls: true };
    });
    await journal.step("sdk", async () => {
      const sdk = await ledger.protocolAction(sdkHandle, () => request(config, "runtime.chat", { runtimeHandle: sdkHandle, executionGeneration: before.executionGeneration, model: MODEL, prompt: "Return the bounded acceptance response." }));
      assert(sdk.runtimeHandle === sdkHandle && sdk.executionGeneration === before.executionGeneration && sdk.text === "scope-sdk-ok" && broker.requests() > 0, "actual_sdk_result_missing");
      return { runtimeHandle: sdkHandle, result: "scope-sdk-ok", transport: "unix_socket_fake_broker", providerCall: false, observedInferenceRequests: broker.requests() };
    });
    await journal.step("broker_mock", async () => {
      check();
      const denied = await brokerExchange(config.brokerSocket, { version: 1, requestId: randomUUID(), action: "host.fetch" });
      assert(denied?.ok === false && denied.error === "action_denied", "broker_mock_action_failed");
      return { lane: "host_fake_broker_protocol_only", workerAccessClaim: false, actionDenied: true };
    });
    await journal.step("first_broker_cleanup", async () => { const previous = broker; broker = undefined; await previous.close(); return { closed: true }; });
    await journal.step("crash", async () => { await assertInventory(); await ledger.supervisorAction("kill"); return { ownMainKilled: true }; });
    const after = await journal.step("restart", async () => {
      const incarnation = await waitFor(async () => ledger.captureExpectedRestart(), "own_restart_identity_unavailable");
      const profile = await waitFor(async () => {
        try { const value = await capability(); return value.executionGeneration !== before.executionGeneration && value; }
        catch (error) { if (["socket_unavailable", "socket_closed", "supervisor_request_failed"].includes(error.message)) return false; throw error; }
      }, "own_restart_failed");
      return { ...profile, incarnation, security: await supervisorConfiguration(config, node) };
    });
    await journal.step("command_cleanup", async () => {
      const supervisor = await supervisorConfiguration(config, node);
      const retained = [];
      for (const handle of [first, peer, sdkHandle]) {
        const state = await ledger.freshWorker(handle);
        const observation = await workerConfiguration(config, handle, dependencies, identity.workerUnit(handle), node);
        assert(state.MainPID === observation.properties.MainPID && state.InvocationID === observation.properties.InvocationID, "cleanup_worker_incarnation_changed");
        await ledger.freshWorker(handle);
        retained.push({ handle, credentials: observation.credentials, commandIpc: observation.commandIpc });
      }
      await journal.step("reconcile", async () => {
        await assertInventory();
        for (const handle of [first, peer, sdkHandle]) {
          await ledger.freshWorker(handle);
          const stopped = await ledger.protocolAction(handle, () => request(config, "runtime.stop", { runtimeHandle: handle }));
          ledger.releaseWorker(handle, stopped);
        }
        return { originalIncarnationsPreserved: true, stoppedHandles: [first, peer, sdkHandle] };
      });
      const removed = await commandCleanup(config, [first, peer, sdkHandle]);
      const afterCleanup = await supervisorConfiguration(config, node);
      assertStableProcess(supervisor.credentials, afterCleanup.credentials);
      assertStableUnit(supervisor.properties, afterCleanup.properties);
      return { ...removed, supervisor: afterCleanup, retained, retainedStagingObservedBeforeStop: true };
    });
    check();
    broker = await brokerStart(config.brokerSocket, dirname(config.runtimeDirectory), check); const { handle: second } = await create(after, "drain");
    await journal.step("drain", async () => {
      await assertInventory(); return gracefulDrain(config, ledger, second, { capture: context.capture });
    });
  } finally {
    const failures = [];
    try { await journal.step("broker_cleanup", async () => { if (broker) await broker.close(); return { ownedBrokerClosed: true }; }); } catch (error) { failures.push(error); }
    try { await journal.step("controls_cleanup", async () => controls ? controls.close() : { notCreated: true }); } catch (error) { failures.push(error); }
    if (failures.length) throw failures[0];
  }
}
