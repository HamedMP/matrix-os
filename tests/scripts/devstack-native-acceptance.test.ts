import { chmod, link, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { resolveScopeRuntimeHostConfig } from "../../packages/scope-runtime/src/host-config.js";
import { ScopeRuntimeRequestSchema, ScopeRuntimeResponseSchema } from "../../packages/scope-runtime/src/protocol.js";
import { supervisorRequest, createTrackedWorker } from "../../scripts/ops/devstack-native/proof.mjs";
import { createJournal } from "../../scripts/ops/devstack-native/receipt.mjs";
import { CASCADE_KEYS, createUnitLedger } from "../../scripts/ops/devstack-native/ownership.mjs";

const scratch: string[] = [];
afterEach(async () => { await Promise.all(scratch.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
const args = ["--namespace=proof", "--app-root=/var/lib/matrix-devstack/proof/app", "--home=/var/lib/matrix-devstack/proof/home", "--mode=preflight"];
const source = "a".repeat(40), lockfile = "b".repeat(64);
async function subject() { return import("../../scripts/ops/devstack-native/control.mjs"); }
async function fixture(workspace = false) {
  const root = await mkdtemp(join(workspace ? process.cwd() : await realpath(tmpdir()), "native-proof-")); scratch.push(root);
  const path = join(root, ".native-acceptance-owner.json");
  const expected = { version: 1, purpose: "matrix-devstack-native-acceptance", namespace: "proof", appRoot: "/var/lib/matrix-devstack/proof/app", home: "/var/lib/matrix-devstack/proof/home", sourceSha: source, lockfileSha256: lockfile };
  await writeFile(path, JSON.stringify(expected), { mode: 0o600 });
  return { root, path, expected };
}

describe("owned native acceptance boundaries", () => {
  it("refuses foreign and noncanonical paths before commands", async () => {
    const { parseOptions, resolveConfig } = await subject();
    expect(resolveConfig(parseOptions(args), resolveScopeRuntimeHostConfig).ownedNode.binary).toBe("/var/lib/matrix-devstack/proof/runtime/node/bin/node");
    for (const replacement of ["--app-root=/opt/matrix/app", "--home=/home/matrix/home", "--namespace=../../foreign", "--mode=destroy"]) {
      const key = replacement.split("=")[0];
      expect(() => resolveConfig(parseOptions(args.map(v => v.startsWith(`${key}=`) ? replacement : v)), resolveScopeRuntimeHostConfig)).toThrow();
    }
    expect(() => parseOptions([...args, "--namespace=other"])).toThrow();
    expect(() => parseOptions(args.map(v => v === "--mode=preflight" ? "--mode=run" : v))).toThrow(/ack/);
  });

  it("refuses foreign marker values, permissive mode, links and symlinked ancestors", async () => {
    const { readOwnerMarker, validateOwnerMarker } = await subject(); const f = await fixture();
    const metadata = await lstat(f.path);
    const rootMetadata = { ...metadata, uid: 0, isFile: () => true };
    const raw = await readFile(f.path, "utf8");
    expect(validateOwnerMarker(rootMetadata, raw, f.expected)).toEqual(f.expected);
    expect(() => validateOwnerMarker(rootMetadata, raw, { ...f.expected, namespace: "foreign" })).toThrow(/marker/);
    expect(() => validateOwnerMarker({ ...rootMetadata, uid: 1000 }, raw, f.expected)).toThrow(/marker/);
    await chmod(f.path, 0o644);
    expect(() => validateOwnerMarker({ ...rootMetadata, mode: (metadata.mode & ~0o777) | 0o644 }, raw, f.expected)).toThrow(/marker/);
    await chmod(f.path, 0o600); await link(f.path, join(f.root, "hardlink"));
    await expect(readOwnerMarker(f.path, f.expected)).rejects.toThrow(/marker/);
    await rm(join(f.root, "hardlink")); await symlink(f.root, `${f.root}-link`); scratch.push(`${f.root}-link`);
    await expect(readOwnerMarker(`${f.root}-link/.native-acceptance-owner.json`, f.expected)).rejects.toThrow(/symlink/);
  });

  it.each(["", 's "255.4"'])("preflight never creates directories, marker, units or receipt (manager Version: %j)", async version => {
    const { preflight } = await subject(); const f = await fixture(true);
    const before = await readdir(f.root);
    const commands: string[][] = [];
    const config = resolveScopeRuntimeHostConfig({ env: { MATRIX_SCOPE_RUNTIME_NAMESPACE: "proof", MATRIX_SCOPE_RUNTIME_APP_ROOT: "/var/lib/matrix-devstack/proof/app", MATRIX_SCOPE_RUNTIME_NODE_ROOT: "/var/lib/matrix-devstack/proof/runtime/node", MATRIX_HOME: "/var/lib/matrix-devstack/proof/home" } });
    Object.assign(config, { runtimeDirectory: join(f.root, "run", "scope-runtime"), commandSocketRoot: join(f.root, "run", "c"), stateRoot: join(f.root, "state", "scope-runtime"), appRoot: join(f.root, "app") });
    await expect(preflight(config, async () => { throw Error("unsafe"); }, async () => {
      commands.push(["unexpected"]); throw Error("must not reach discovery");
    })).rejects.toThrow("owned_node_unprotected_or_unavailable");
    expect(commands).toEqual([]);
    const harnessNode = { inode: "123", device: "4", sha256: "5".repeat(64) };
    const result = await preflight(config, async (path: string) => { expect(path).toBe("/var/lib/matrix-devstack/proof/runtime/node"); return harnessNode; }, async (bin: string, argv: string[]) => {
      commands.push(argv);
      if (bin === "/usr/bin/busctl") return { code: 0, stdout: version };
      return { code: 0, stdout: argv.includes("show") ? "LoadState=not-found\n" : argv[0] === "list-unit-files" ? "matrix-gateway.service enabled enabled" : "" };
    });
    expect(result.harnessNode).toEqual(harnessNode); expect(result.ready).toBe(false); expect(await readdir(f.root)).toEqual(before);
    // An installed but unusable system bus must block before run mode can reserve the namespace.
    expect(result.blockers.includes("system_bus_unavailable")).toBe(version === "");
    expect(commands).toHaveLength(4);
    expect(commands.slice(0, 3).every(argv => ["show", "list-units", "list-unit-files"].includes(argv[0]))).toBe(true);
    expect(commands[3]).toEqual(["--system", "get-property", "org.freedesktop.systemd1", "/org/freedesktop/systemd1", "org.freedesktop.systemd1.Manager", "Version"]);
    expect(await readFile(f.path, "utf8")).toContain('"namespace":"proof"');
  });

  it("refuses inactive foreign units and ambiguous partial state", async () => {
    const { assertVacant } = await subject();
    const config = { supervisorUnit: "matrix-devstack-proof-scope-runtime.service", workerUnitPrefix: "matrix-devstack-proof-scope-runtime-", runtimeDirectory: "/nonexistent-native-proof/r", commandSocketRoot: "/nonexistent-native-proof/c", stateRoot: "/nonexistent-native-proof/s" };
    await expect(assertVacant(config, async () => ({ code: 0, stdout: "LoadState=loaded\nActiveState=inactive\n" }))).rejects.toThrow(/unit/);
    const f = await fixture();
    await expect(assertVacant({ ...config, stateRoot: f.root }, async (_: string, argv: string[]) => ({ code: 0, stdout: argv[0] === "show" ? "LoadState=not-found\n" : argv[0] === "list-unit-files" ? "matrix-gateway.service enabled enabled" : "" }))).rejects.toThrow(/state/);
  });


});

// Keep request/reply framing real: losing a valid rejection or trusting an
// unrelated/malformed reply must change the private diagnostic, never authority.
describe("native supervisor rejection diagnostics", () => {
  const createPayload = { scopeHandle: "scope_" + "a".repeat(32), profileId: "scope-runtime-chat-v1", workload: "chat_ai", adapterId: "claude-code", harnessVersion: "2.1.240" };
  const runtimeHandle = "runtime_" + "b".repeat(32);
  async function peer(reply: (request: any) => unknown, action: (config: any, root: string) => Promise<void>) {
    const root = await mkdtemp("/tmp/native-reply-"); scratch.push(root);
    const supervisorSocket = join(root, "s"); let failure: unknown;
    const server = createServer({ allowHalfOpen: true }, socket => {
      let input = Buffer.alloc(0);
      socket.setTimeout(1000, () => socket.destroy());
      socket.on("error", error => { failure ??= error; });
      socket.on("data", chunk => {
        input = Buffer.concat([input, chunk]);
        if (input.length > 4096) { failure = Error("fixture_request_capacity"); socket.destroy(); return; }
        if (!input.includes(10)) return;
        try {
          const request = ScopeRuntimeRequestSchema.parse(JSON.parse(input.subarray(0, input.indexOf(10)).toString("utf8")));
          socket.end(JSON.stringify(reply(request)) + "\n");
        } catch (error) { failure = error; socket.destroy(); }
      });
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(supervisorSocket, resolve); });
    try { await action({ supervisorSocket }, root); }
    finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
    expect(failure).toBeUndefined();
  }
  const negative = (request: any, error: unknown = "runtime_unavailable") => ({ version: 1, type: "runtime.result", requestId: request.requestId, ok: false, error });
  async function persistedFailure(config: any, root: string, type: string, payload: any, code: string) {
    const journal = createJournal();
    await expect(journal.step("capability", () => supervisorRequest(config, type, payload))).rejects.toThrow(new Error(code));
    const path = join(root, "receipt.json");
    await writeFile(path, JSON.stringify(journal.result()), { mode: 0o600 });
    const persisted = await readFile(path, "utf8");
    expect(JSON.parse(persisted)).toMatchObject({ status: "failed", gates: { capability: { state: "failed", code } } });
    // No reply/error object, identifiers or attacker-controlled text enters diagnostics.
    expect(persisted).not.toMatch(/secret_marker|requestId|runtimeHandle|scopeHandle|\/private\//);
  }
  const cases = [
    ["capability.get", {}, "capability.result", ["invalid_request", "profile_unavailable", "runtime_unavailable"]],
    ["runtime.create", createPayload, "runtime.result", ["invalid_request", "profile_unavailable", "adapter_unavailable", "capacity_exceeded", "runtime_not_found", "runtime_unavailable"]],
    ["runtime.stop", { runtimeHandle }, "runtime.result", ["invalid_request", "profile_unavailable", "adapter_unavailable", "capacity_exceeded", "runtime_not_found", "runtime_unavailable"]],
    ["runtime.chat", { runtimeHandle, executionGeneration: "7", model: "claude-haiku-4-5-20251001", prompt: "fixture" }, "runtime.chat.result", ["invalid_request", "runtime_not_found", "runtime_unavailable", "generation_mismatch"]],
  ] as const;
  it.each(cases.flatMap(([type, payload, responseType, errors]) => errors.map(code => ({ type, payload, responseType, code }))))("persists matching $type rejection $code", async ({ type, payload, responseType, code }) => {
    await peer(request => ScopeRuntimeResponseSchema.parse({ ...negative(request, code), type: responseType }), (config, root) => persistedFailure(config, root, type, payload, code));
  });
  it.each([
    "request_id", "type", "version", "version_string", "ok", "extra_field", "unknown_string", "unknown_code", "object", "array", "null_error", "missing_error", "wrong_type_code", "null_reply",
  ])("keeps %s reply generic without persisting its content", async fault => {
    await peer(request => {
      const reply: any = negative(request);
      if (fault === "request_id") reply.requestId = "00000000-0000-4000-8000-000000000000";
      if (fault === "type") reply.type = "runtime.chat.result";
      if (fault === "version") reply.version = 2;
      if (fault === "version_string") reply.version = "1";
      if (fault === "ok") reply.ok = "false";
      if (fault === "extra_field") reply.detail = "/private/secret_marker";
      if (fault === "unknown_string") reply.error = "/private/secret_marker token=credential";
      if (fault === "unknown_code") reply.error = "secret_marker";
      if (fault === "object") reply.error = { message: "runtime_unavailable", secret_marker: "credential" };
      if (fault === "array") reply.error = ["runtime_unavailable"];
      if (fault === "null_error") reply.error = null;
      if (fault === "missing_error") delete reply.error;
      if (fault === "wrong_type_code") reply.error = "generation_mismatch";
      return fault === "null_reply" ? null : reply;
    }, (config, root) => persistedFailure(config, root, "runtime.create", createPayload, "supervisor_request_failed"));
  });
  it("keeps a matching success unchanged", async () => {
    await peer(request => ScopeRuntimeResponseSchema.parse({ version: 1, type: "runtime.result", requestId: request.requestId, ok: true, runtimeHandle, executionGeneration: "7", state: "running" }), async config => {
      const reply = await supervisorRequest(config, "runtime.create", createPayload);
      expect(reply).toEqual({ version: 1, type: "runtime.result", requestId: expect.any(String), ok: true, runtimeHandle, executionGeneration: "7", state: "running" });
    });
  });
  it("retains unknown partial-create quarantine and prevents supervisor mutation after a valid rejection", async () => {
    await peer(request => ScopeRuntimeResponseSchema.parse(negative(request)), async config => {
      const cfg = { ...config, supervisorUnit: "fixture.service", workerUnitPrefix: "fixture-" };
      let mutations = 0;
      const owner = { Description: "fixture", Transient: "yes", LoadState: "loaded", InvocationID: "a".repeat(32), MainPID: "41", DefinitionIdentity: "definition", ...Object.fromEntries(CASCADE_KEYS.map((key: string) => [key, ""])) };
      const ledger = createUnitLedger(cfg, "fixture", { observe: async () => owner, mutate: async () => { mutations++; } });
      ledger.submitted(); await ledger.captureSupervisor();
      await expect(createTrackedWorker(cfg, { profileId: createPayload.profileId, executionGeneration: "7", adapter: { harnessVersion: createPayload.harnessVersion } }, ledger, async () => {}, { inventory: async () => [] })).rejects.toThrow("runtime_unavailable");
      expect(ledger.quarantine()).toEqual([{ scopeHandle: expect.stringMatching(/^scope_[a-f0-9]{32}$/), code: "runtime_unavailable", state: "quarantined_unknown" }]);
      expect(ledger.evidence().workers).toEqual([]);
      await expect(ledger.supervisorAction("kill")).rejects.toThrow("supervisor_drain_unproved_workers");
      expect(mutations).toBe(0);
    });
  });
});

describe("native proof transport and fixed service profile", () => {
  it("answers a real Unix broker request without accepting arbitrary actions", async () => {
    const { startBroker, exchange } = await import("../../scripts/ops/devstack-native/proof.mjs");
    const f = await fixture(); const socket = join(f.root, "broker.sock");
    const broker = await startBroker(socket);
    try {
      await expect(startBroker(socket)).rejects.toThrow("broker_collision");
      expect(await exchange(socket, { version: 1, requestId: "proof", action: "host.fetch" })).toMatchObject({ ok: false, error: "action_denied" });
      const reply = await exchange(socket, { version: 1, requestId: "proof", action: "inference.messages", method: "POST", path: "/v1/messages?beta=true", body: JSON.stringify({ model: "claude-haiku-4-5-20251001", messages: [] }) });
      expect(reply).toMatchObject({ ok: true, status: 200 });
      expect(reply.body).toContain('"text":"scope-sdk-ok"');
      expect(broker.requests()).toBe(1);
    } finally { await broker.close(); }
    await expect(readFile(socket)).rejects.toThrow();
  });

  it("retains every service restriction while moving only owned placement", async () => {
    const { supervisorArgs } = await import("../../scripts/ops/devstack-native/proof.mjs");
    const template = await readFile(new URL("../../distro/customer-vps/systemd/matrix-scope-runtime.service", import.meta.url), "utf8");
    const config = resolveScopeRuntimeHostConfig({ env: { MATRIX_SCOPE_RUNTIME_NAMESPACE: "proof", MATRIX_SCOPE_RUNTIME_APP_ROOT: "/var/lib/matrix-devstack/proof/app", MATRIX_SCOPE_RUNTIME_NODE_ROOT: "/var/lib/matrix-devstack/proof/runtime/node", MATRIX_HOME: "/var/lib/matrix-devstack/proof/home" } });
    const result = supervisorArgs(config, "matrix-native-proof-token", template);
    expect(result).toContain("--property=StandardError=append:/var/lib/matrix-devstack/proof/.matrix-native-proof-token.stderr");
    expect(result).toContain("--property=LimitFSIZE=65536");
    expect(result).toContain("MATRIX_SCOPE_RUNTIME_NODE_ROOT=/var/lib/matrix-devstack/proof/runtime/node");
    expect(result).toContain("PATH=/var/lib/matrix-devstack/proof/runtime/node/bin:/usr/bin:/bin");
    expect(result).toContain("/var/lib/matrix-devstack/proof/runtime/node/bin/node");
    expect(result).not.toContain("/opt/matrix/runtime/node/bin/node");
    expect(result).toContain("--property=PrivateNetwork=yes");
    expect(result).toContain("--property=CapabilityBoundingSet=");
    expect(result).toContain("--property=RestrictAddressFamilies=AF_UNIX");
    expect(result).toContain("--property=ReadWritePaths=/run/matrix-devstack/proof/scope-runtime /run/matrix-devstack/proof/c");
    expect(result).toContain("--property=StateDirectory=matrix-devstack/proof/scope-runtime");
    expect(result).toContain("/var/lib/matrix-devstack/proof/app/packages/scope-runtime/dist/main.js");
    expect(result.some((v: string) => v.includes("/opt/matrix/app") || v.includes("/home/matrix/home"))).toBe(false);
  });
});

it("CLI preflight emits a blocked receipt without creating canonical paths", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  const outcome = await run(process.execPath, ["scripts/ops/devstack-native-acceptance.mjs", ...args], { timeout: 5000 }).catch(error => error);
  expect(outcome.code).toBe(2);
  expect(JSON.parse(outcome.stdout)).toMatchObject({ mode: "preflight", ready: false });
  expect(outcome.stderr).toBe("");
});

it("bounds command runtime and discards oversized failed output", async () => {
  const { command } = await subject();
  const timeout = await command(process.execPath, ["-e", "setInterval(()=>{},1000)"], 60);
  expect(timeout.code).not.toBe(0); expect(timeout.stdout).toBe("");
  const oversized = await command(process.execPath, ["-e", "process.stdout.write('x'.repeat(300000))"], 3000);
  expect(oversized.code).not.toBe(0); expect(oversized.stdout).toBe("");
});

it("refuses inactive namespace worker units before touching state", async () => {
  const { assertVacant } = await subject();
  await expect(assertVacant({ supervisorUnit: "matrix-devstack-proof-scope-runtime.service", workerUnitPrefix: "matrix-devstack-proof-scope-runtime-" }, async (_: string, argv: string[]) => ({ code: 0, stdout: argv[0] === "show" ? "LoadState=not-found" : "matrix-devstack-proof-scope-runtime-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.service loaded inactive dead" }))).rejects.toThrow(/worker_unit/);
});

it("does not accept a failed worker as graceful drain evidence", async () => {
  const { assertDrained } = await import("../../scripts/ops/devstack-native/proof.mjs");
  expect(() => assertDrained("ActiveState=inactive")).not.toThrow();
  for (const state of ["active", "failed", "deactivating", "activating"]) expect(() => assertDrained(`ActiveState=${state}`)).toThrow();
});

it("rechecks namespace vacancy under its own lock and rejects another invocation lock", async () => {
  const { assertVacant } = await subject(); const f = await fixture();
  const config = { supervisorUnit: "matrix-devstack-proof-scope-runtime.service", workerUnitPrefix: "matrix-devstack-proof-scope-runtime-", runtimeDirectory: join(f.root, "run"), commandSocketRoot: join(f.root, "c"), stateRoot: join(f.root, "state") };
  const discover = async (_: string, argv: string[]) => ({ code: 0, stdout: argv[0] === "show" ? "LoadState=not-found" : argv[0] === "list-unit-files" ? "matrix-gateway.service enabled enabled" : "" });
  await expect(assertVacant(config, discover)).resolves.toBeUndefined();
  const lock = await open(join(f.root, ".native-acceptance-active"), "wx", 0o600);
  try {
    await expect(assertVacant(config, discover)).rejects.toThrow(/state/);
    await expect(assertVacant(config, discover, await lock.stat())).resolves.toBeUndefined();
    await mkdir(config.stateRoot);
    await expect(assertVacant(config, discover, await lock.stat())).rejects.toThrow(/state/);
  } finally { await lock.close(); }
});

it("caps total socket exchange time even when a peer keeps sending bytes", async () => {
  const { exchange } = await import("../../scripts/ops/devstack-native/proof.mjs");
  const { createServer } = await import("node:net"); const f = await fixture(); const path = join(f.root, "drip.sock");
  const sockets = new Set<import("node:net").Socket>();
  const server = createServer({ allowHalfOpen: true }, socket => {
    sockets.add(socket); const drip = setInterval(() => socket.write(" "), 5);
    socket.on("error", () => socket.destroy()); socket.once("close", () => { clearInterval(drip); sockets.delete(socket); });
  });
  await new Promise<void>(resolve => server.listen(path, resolve));
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([exchange(path, {}, 50).catch(error => error.message), new Promise(resolve => { deadline = setTimeout(() => resolve("not_bounded"), 300); })]);
    expect(result).toBe("socket_timeout");
  } finally {
    clearTimeout(deadline); for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

it("preserves a replaced broker pathname through owner process exit", async () => {
  const { execFile } = await import("node:child_process"); const { promisify } = await import("node:util");
  const f = await fixture(); const path = join(f.root, "broker.sock");
  const source = new URL("../../scripts/ops/devstack-native/proof.mjs", import.meta.url).href;
  const script = `import { startBroker } from ${JSON.stringify(source)}; import { rename, writeFile } from 'node:fs/promises';
    const path=process.argv[1]; const owner=await startBroker(path); await rename(path,path+'.old');
    await writeFile(path,'foreign-path', {flag:'wx'});
    let refused=false; try{await owner.close()}catch(error){refused=error.message==='broker_cleanup_ownership_lost'}
    console.log(JSON.stringify({refused}));`;
  const result = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script, path], { timeout: 3000 });
  expect(JSON.parse(result.stdout)).toEqual({ refused: true });
  expect(await readFile(path, "utf8")).toBe("foreign-path");
});

it("fails closed on an overlong private bind path and removes only its empty staging directory", async () => {
  const { startBroker } = await import("../../scripts/ops/devstack-native/proof.mjs");
  const f = await fixture(); const parent = join(f.root, "b".repeat(80)); await mkdir(parent, { mode: 0o700 });
  await expect(startBroker(join(f.root, "public.sock"), parent)).rejects.toThrow("broker_bind_path_capacity");
  expect(await readdir(parent)).toEqual([]);
  await expect(lstat(join(f.root, "public.sock"))).rejects.toThrow();
});

it("rejects an atomic same-path Node replacement before and after auditing the harness process", async () => {
  const { attestRunningNode, verifyExecutableEvidence } = await import("../../scripts/ops/devstack-native/node-evidence.mjs");
  const { rename, link } = await import("node:fs/promises");
  const f = await fixture(), host = join(f.root, "node"), running = join(f.root, "running-image");
  await writeFile(host, "same bytes"); await link(host, running);
  const preflightNode = await attestRunningNode(host, running);
  const replacement = join(f.root, "next"); await writeFile(replacement, "same bytes"); await rename(replacement, host);
  await expect(attestRunningNode(host, running)).rejects.toThrow("node_executable_mismatch");
  await expect(verifyExecutableEvidence(host, preflightNode)).rejects.toThrow("node_executable_mismatch");
});
