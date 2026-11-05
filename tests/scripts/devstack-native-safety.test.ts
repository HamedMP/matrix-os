import { execFile, spawn, type SpawnOptions } from "node:child_process";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
const scratch: string[] = [];
afterEach(async () => { await Promise.all(scratch.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() { const root = await mkdtemp(join(process.cwd(), ".native-safety-")); scratch.push(root); return root; }

it("contains malformed broker frames inside the connection and reaches receipt cleanup", async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "native-safe-")); scratch.push(root); const module = new URL("../../scripts/ops/devstack-native/proof.mjs", import.meta.url).href;
  const script = `import {startBroker,exchange} from ${JSON.stringify(module)}; import{writeFile}from'node:fs/promises';
    const root=process.argv[1], path=root+'/broker'; const broker=await startBroker(path);
    try{for(const frame of [null,[],1,'text',{}]){const r=await exchange(path,frame); if(r.ok!==false)throw Error('malformed_accepted')}
    const r=await exchange(path,{version:1,requestId:'probe',action:'inference.messages',method:'HEAD',path:'/api/hello'}); if(r.ok!==true)throw Error('did_not_survive');}
    finally{await broker.close();await writeFile(root+'/receipt.json',JSON.stringify({cleanup:'passed'}))}`;
  const outcome = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script, root], { timeout: 5000 }).catch(error => error);
  expect(outcome.code ?? 0).toBe(0);
  expect(JSON.parse(await readFile(join(root, "receipt.json"), "utf8"))).toEqual({ cleanup: "passed" });
});

it.each(["symlink", "dangling", "writable"])("rejects %s placement ancestry before any unit submission", async kind => {
  const { submitSupervisor } = await import("../../scripts/ops/devstack-native/submission.mjs");
  const root = await fixture(); const foreign = join(root, "foreign"); await mkdir(foreign);
  const parent = join(root, "runtime");
  if (kind === "writable") { await mkdir(parent); await chmod(parent, 0o777); }
  else await symlink(kind === "dangling" ? join(root, "absent") : foreign, parent);
  const config = { runtimeDirectory: join(parent, "proof", "scope-runtime"), commandSocketRoot: join(parent, "proof", "c"), stateRoot: join(root, "state", "proof", "scope-runtime") };
  let submissions = 0;
  const start = async () => submitSupervisor(config, "matrix-native-test", "[Service]\nProtectSystem=strict\nPrivateNetwork=yes\n", { submitted() {}, captureSupervisor: async () => ({}) }, async (binary: string) => { if (binary === "/usr/bin/systemd-run") submissions++; return { code: 0, stdout: "" }; });
  await expect(start()).rejects.toThrow(/placement/); expect(submissions).toBe(0);
  expect(await readdir(foreign)).toEqual([]);
});

function units() {
  const supervisor = "matrix-devstack-proof-scope-runtime.service", worker = `matrix-devstack-proof-scope-runtime-${"a".repeat(32)}.service`;
  const config = { supervisorUnit: supervisor, workerUnitPrefix: "matrix-devstack-proof-scope-runtime-", stateRoot: "/var/lib/matrix-devstack/proof/scope-runtime" };
  const state: Record<string, Record<string, string>> = {
    [supervisor]: { LoadState: "loaded", DefinitionIdentity: "supervisor-definition", KillSignal: "9", RuntimeDirectoryPreserve: "yes", BoundBy: "", ConsistsOf: "", RequiredBy: "", RequisiteOf: "", PropagatesStopTo: "", PartOf: "", BindsTo: "", OnFailure: "", OnSuccess: "", ExecStop: "", ExecStopPost: "", Description: "matrix-native-token", Transient: "yes", InvocationID: "1".repeat(32), MainPID: "41", ActiveState: "active" },
    [worker]: { LoadState: "loaded", DefinitionIdentity: "worker-definition", KillSignal: "15", BoundBy: "", ConsistsOf: "", RequiredBy: "", RequisiteOf: "", PropagatesStopTo: "", PartOf: "", BindsTo: "", OnFailure: "", OnSuccess: "", ExecStop: "", ExecStopPost: "", Transient: "yes", DynamicUser: "yes", InvocationID: "2".repeat(32), MainPID: "42", ActiveState: "active", RootDirectory: `/var/lib/matrix-devstack/proof/scope-runtime/runtimes/${"a".repeat(32)}/root` },
  };
  return { supervisor, worker, config, state };
}
it("does not mutate a foreign lookalike from inventory or a replaced supervisor", async () => {
  const { createUnitLedger } = await import("../../scripts/ops/devstack-native/ownership.mjs");
  const f = units(), mutations: string[] = [];
  const ledger = createUnitLedger(f.config, "matrix-native-token", { observe: async (name: string) => f.state[name], mutate: async (_: string, name: string) => { mutations.push(name); } });
  ledger.submitted(); await ledger.captureSupervisor();
  ledger.inventory([f.worker]);
  f.state[f.supervisor].InvocationID = "3".repeat(32);
  await expect(ledger.supervisorAction("kill")).rejects.toThrow(/incarnation/);
  const results = await ledger.cleanup();
  expect(mutations).toEqual([]); expect(results.some((r: {state: string}) => r.state === "failed")).toBe(true);
});
it("attempts proven worker cleanup independently after supervisor stop failure", async () => {
  const { createUnitLedger } = await import("../../scripts/ops/devstack-native/ownership.mjs");
  const f = units(), attempts: string[] = [];
  const ledger = createUnitLedger(f.config, "matrix-native-token", { observe: async (name: string) => f.state[name], mutate: async (_: string, name: string) => { attempts.push(name); if (name === f.supervisor) throw Error("stop_failed"); } });
  ledger.submitted(); await ledger.captureSupervisor();
  await ledger.recordWorker({ runtimeHandle: `runtime_${"a".repeat(32)}`, executionGeneration: "1" });
  const results = await ledger.cleanup();
  expect(attempts).toEqual([f.supervisor, f.worker]);
  expect(results.map((r: {state: string}) => r.state)).toEqual(["failed", "passed"]);
});
it("retains completed SDK evidence after a later gate fails and strips unknown protocol fields", async () => {
  const { createJournal, safeCapability } = await import("../../scripts/ops/devstack-native/receipt.mjs");
  const journal = createJournal();
  await journal.step("sdk", async () => ({ result: "scope-sdk-ok", transport: "unix_socket_fake_broker" }));
  await expect(journal.step("drain", async () => { throw Error("drain_failed"); })).rejects.toThrow();
  expect(journal.result().gates.sdk).toMatchObject({ state: "passed", evidence: { result: "scope-sdk-ok" } });
  expect(journal.result().status).toBe("failed");
  const adapter = { adapterId: "claude-code", harnessVersion: "2.1.240" };
  expect(() => safeCapability({ profile: { profileId: "scope-runtime-chat-v1", profileVersion: 2, profileDigest: "a".repeat(64),
    executionGeneration: "1", adapters: [adapter, { adapterId: "codex", harnessVersion: "0.162.1" }] } })).toThrow("capability_invalid");
  expect(safeCapability({ profile: { profileId: "scope-runtime-chat-v1", profileVersion: 2, profileDigest: "a".repeat(64), executionGeneration: "1", adapters: [{ adapterId: "claude-code", harnessVersion: "2.1.240", secret: "never-store" }] }, secret: "never-store" })).not.toHaveProperty("secret");
});
it("rejects two matching dependency manifests from outside the owned checkout before version execution", async () => {
  const { verifyDependencies } = await import("../../scripts/ops/devstack-native/dependencies.mjs");
  const root = await fixture(); const app = join(root, "app"); await mkdir(join(app, "node_modules", "@anthropic-ai"), { recursive: true });
  for (const name of ["claude-agent-sdk", "claude-agent-sdk-linux-x64"]) {
    const target = join(root, "outside", name); await mkdir(target, { recursive: true });
    await writeFile(join(target, "package.json"), JSON.stringify({ name: `@anthropic-ai/${name}`, version: "0.3.240" }));
    await symlink(target, join(app, "node_modules", "@anthropic-ai", name));
  }
  await expect(verifyDependencies({ appRoot: app }, {})).rejects.toThrow(/outside_owned/);
});

it("verifies archive SRI before parsing and matches every installed regular member", async () => {
  const { archiveMembers, digestFile, verifyInstalledMembers } = await import("../../scripts/ops/devstack-native/archive.mjs");
  const root = await fixture(), pkg = join(root, "package"); await mkdir(pkg);
  await writeFile(join(pkg, "package.json"), '{"name":"fixture","version":"1.0.0"}');
  await writeFile(join(pkg, "sdk.mjs"), "export const fixture = true;\n");
  const archive = join(root, "package.tgz"); await promisify(execFile)("/usr/bin/tar", ["--format=ustar", "-czf", archive, "-C", root, "package"]);
  const sri = `sha512-${(await digestFile(archive, "sha512")).digest}`;
  await expect(archiveMembers(archive, `sha512-${"A".repeat(86)}==`)).rejects.toThrow("package_integrity_mismatch");
  const verified = await archiveMembers(archive, sri);
  expect((await verifyInstalledMembers(pkg, verified.members)).memberCount).toBe(2);
  await writeFile(join(pkg, "sdk.mjs"), "different-code");
  await expect(verifyInstalledMembers(pkg, verified.members)).rejects.toThrow("installed_package_digest_mismatch");
});

function profileFixture() {
  const suffix = "a".repeat(32), root = `/var/lib/matrix-devstack/proof/scope-runtime/runtimes/${suffix}`;
  const config = { ownedNode: { root: "/var/lib/matrix-devstack/proof/runtime/node", workerRoot: "/opt/matrix/runtime/node" }, stateRoot: "/var/lib/matrix-devstack/proof/scope-runtime", commandSocketRoot: "/run/matrix-devstack/proof/c", brokerSocket: "/run/matrix-devstack/proof/scope-runtime/broker.sock" };
  const deps = { sdk: { root: "/owned/sdk" }, native: { root: "/owned/native" }, workerFile: "/owned/worker.js" };
  const properties = { Type: "exec", User: "matrix-scope-workload", KillMode: "control-group", DynamicUser: "yes", PrivateUsers: "yes", RootDirectory: `${root}/root`, MountAPIVFS: "yes", PrivateNetwork: "yes", PrivateIPC: "yes", PrivateTmp: "yes", PrivateDevices: "yes", ProtectProc: "invisible", ProcSubset: "pid", ProtectSystem: "strict", ProtectHome: "yes", ProtectKernelTunables: "yes", ProtectKernelModules: "yes", ProtectKernelLogs: "yes", ProtectControlGroups: "yes", ProtectClock: "yes", ProtectHostname: "yes", NoNewPrivileges: "yes", CapabilityBoundingSet: "", AmbientCapabilities: "", RestrictAddressFamilies: "AF_INET6 AF_UNIX AF_INET", RestrictNamespaces: "yes", RestrictRealtime: "yes", RestrictSUIDSGID: "yes", SystemCallArchitectures: "native", MemoryMax: "1073741824", CPUQuotaPerSecUSec: "2s", TasksMax: "256", WorkingDirectory: "/workspace", UMask: "0077", RuntimeMaxUSec: "1min 30s", TimeoutStopUSec: "10s", TemporaryFileSystem: "/tmp:rw,nosuid,nodev,noexec,size=67108864,mode=1777 /workspace:rw,nodev,nosuid,size=10G,mode=1777", BindReadOnlyPaths: "/lib:/lib:rbind /lib64:/lib64:rbind /usr/lib:/usr/lib:rbind /usr/bin/env:/usr/bin/env:rbind /var/lib/matrix-devstack/proof/runtime/node:/opt/matrix/runtime/node:rbind /owned/sdk:/opt/matrix/scope-sdk/sdk:rbind /owned/native:/opt/matrix/scope-sdk/native:rbind /owned/worker.js:/opt/matrix/scope-runtime/worker.mjs:rbind", BindPaths: `${config.brokerSocket}:/run/matrix-scope/broker.sock:rbind ${root}/ready:/run/matrix-scope-readiness/ready:rbind ${config.commandSocketRoot}/${suffix}:/run/matrix-scope-command:rbind` };
  return { config, deps, properties, handle: `runtime_${suffix}` };
}
it("rejects drift in normalized binds, restrictions, tmpfs, timeouts and actual root identity", async () => {
  const { validateWorkerProperties, assertRootIdentity } = await import("../../scripts/ops/devstack-native/security.mjs");
  const f = profileFixture(); expect(() => validateWorkerProperties(f.properties, f.config, f.handle, f.deps)).not.toThrow();
  for (const patch of [{ BindReadOnlyPaths: f.properties.BindReadOnlyPaths.replace(f.config.ownedNode.root, f.config.ownedNode.workerRoot) }, { BindPaths: `${f.properties.BindPaths} /outside:/extra:rbind` }, { RestrictNamespaces: "no" }, { RestrictAddressFamilies: "AF_UNIX AF_INET AF_INET6 AF_PACKET" }, { RuntimeMaxUSec: "2min" }, { TemporaryFileSystem: f.properties.TemporaryFileSystem.replace("10G", "11G") }, { RootDirectory: "/other" }]) {
    expect(() => validateWorkerProperties({ ...f.properties, ...patch }, f.config, f.handle, f.deps)).toThrow();
  }
  expect(() => assertRootIdentity({ ino: 1, dev: 2 }, { ino: 1, dev: 3 })).toThrow();
});
it("detects a unit definition replacement with unchanged service incarnation", async () => {
  const { definitionEvidence } = await import("../../scripts/ops/devstack-native/baseline.mjs");
  const root = await fixture(), path = join(root, "matrix-peer.service"); await writeFile(path, "[Service]\nPrivateNetwork=yes\n");
  const first = await definitionEvidence({ FragmentPath: path, DropInPaths: "" });
  await writeFile(path, "[Service]\nPrivateNetwork=no\n");
  expect(await definitionEvidence({ FragmentPath: path, DropInPaths: "" })).not.toEqual(first);
  await expect(definitionEvidence({ FragmentPath: "", DropInPaths: "" })).rejects.toThrow(/definition_missing/);
});

it("refuses public unlink when a writer gains directory access during pathname observation", async () => {
  const { exclusiveDirectory } = await import("../../scripts/ops/devstack-native/placement.mjs");
  const { removePublishedSocket } = await import("../../scripts/ops/devstack-native/proof.mjs");
  const root = await fixture(), path = join(root, "published"); await writeFile(path, "owned");
  const owned = await lstat(path); const guard = await exclusiveDirectory(root);
  let unlinks = 0;
  try {
    await expect(removePublishedSocket(path, owned, guard, { stat: async () => {
      const original = await lstat(path); await chmod(root, 0o770); await rm(path); await writeFile(path, "foreign"); return original;
    }, unlink: async () => { unlinks++; await rm(path); } })).rejects.toThrow("publication_directory_not_exclusive");
    expect(unlinks).toBe(0); expect(await readFile(path, "utf8")).toBe("foreign");
  } finally { await guard.close(); await chmod(root, 0o700); }
});

it("claims a failed partial start only from its unpredictable token and fresh incarnation", async () => {
  const { createUnitLedger } = await import("../../scripts/ops/devstack-native/ownership.mjs");
  const f = units(), stopped: string[] = [];
  const io = { observe: async (name: string) => f.state[name], mutate: async (_: string, name: string) => { stopped.push(name); } };
  const own = createUnitLedger(f.config, "matrix-native-token", io); own.submitted();
  expect((await own.cleanup()).map((item: {state: string}) => item.state)).toEqual(["passed"]);
  expect(stopped).toEqual([f.supervisor]); stopped.length = 0;
  f.state[f.supervisor].Description = "foreign";
  const foreign = createUnitLedger(f.config, "matrix-native-token", io); foreign.submitted();
  expect((await foreign.cleanup())[0].state).toBe("failed"); expect(stopped).toEqual([]);
});

it("requires the original transient definition across an expected supervisor restart", async () => {
  const { createUnitLedger } = await import("../../scripts/ops/devstack-native/ownership.mjs");
  const f = units(); const ledger = createUnitLedger(f.config, "matrix-native-token", { observe: async (name: string) => f.state[name], mutate: async () => {} });
  ledger.submitted(); await ledger.captureSupervisor(); await ledger.supervisorAction("kill");
  f.state[f.supervisor].InvocationID = "3".repeat(32); f.state[f.supervisor].MainPID = "43";
  f.state[f.supervisor].DefinitionIdentity = "replacement-definition";
  await expect(ledger.captureSupervisor({ restart: true })).rejects.toThrow("supervisor_restart_incarnation_unproven");
});
it("rejects timeouts and arbitrary network errors instead of counting them as denials", async () => {
  const { validateDenials } = await import("../../scripts/ops/devstack-native/controls.mjs");
  const controls = { filePath: "/owned/control", targets: [{ path: "/peer/c/worker.sock", role: "owned_peer_command" }] };
  const result = { brokerPositive: true, noExternalInterface: true, noExternalRoute: true, tcp: "ECONNREFUSED", unix: [{ path: "/peer/c/worker.sock", role: "owned_peer_command", code: "ENOENT" }], files: ["/owned/control", "/opt/matrix/env/host.env", "/home/matrix/home", "/root"].map(path => ({ path, code: "EACCES" })) };
  expect(() => validateDenials(result, controls)).not.toThrow();
  for (const patch of [{ tcp: "TIMEOUT" }, { tcp: "EINVAL" }, { brokerPositive: false }, { noExternalRoute: false }, { unix: [{ ...result.unix[0], code: "CONNECTED" }] }]) expect(() => validateDenials({ ...result, ...patch }, controls)).toThrow();
});
it("retains peer command socket replacement evidence while service fields stay unchanged", async () => {
  const { socketInventory } = await import("../../scripts/ops/devstack-native/baseline.mjs"); const { createServer } = await import("node:net");
  const prefix = process.platform === "darwin" ? "/private/tmp/ns-" : join(tmpdir(), "ns-");
  const root = await mkdtemp(prefix); scratch.push(root); const command = join(root, "c", "a".repeat(32)); await mkdir(command, { recursive: true });
  const path = join(command, "worker.sock"); const first = createServer(), second = createServer();
  try {
    await new Promise<void>(resolve => first.listen(path, resolve));
    const before = await socketInventory([{ path: join(root, "c"), depth: 1, role: "peer_command" }]);
    await rename(path, `${path}.old`); await new Promise<void>(resolve => second.listen(path, resolve));
    const after = await socketInventory([{ path: join(root, "c"), depth: 1, role: "peer_command" }]);
    expect(after.sockets[path].inode).not.toBe(before.sockets[path].inode);
    expect({ service: { MainPID: "42", InvocationID: "same" }, sockets: after }).not.toEqual({ service: { MainPID: "42", InvocationID: "same" }, sockets: before });
  } finally { if (second.listening) await new Promise<void>(resolve => second.close(() => resolve())); if (first.listening) await new Promise<void>(resolve => first.close(() => resolve())); }
});
it("rejects authenticated archives containing a symlink rather than following its target", async () => {
  const { archiveMembers, digestFile } = await import("../../scripts/ops/devstack-native/archive.mjs");
  const root = await fixture(); await mkdir(join(root, "package")); await symlink("/opt/matrix/app", join(root, "package", "foreign"));
  const archive = join(root, "package.tgz"); await promisify(execFile)("/usr/bin/tar", ["--format=ustar", "-czf", archive, "-C", root, "package"]);
  const sri = `sha512-${(await digestFile(archive, "sha512")).digest}`;
  await expect(archiveMembers(archive, sri)).rejects.toThrow("archive_member_type_unsupported");
});

it("keeps a conclusively created worker eligible for cleanup when isolation properties fail", async () => {
  const { createUnitLedger } = await import("../../scripts/ops/devstack-native/ownership.mjs"); const { createJournal } = await import("../../scripts/ops/devstack-native/receipt.mjs");
  const f = units(), stopped: string[] = []; f.state[f.worker].DynamicUser = "no"; f.state[f.worker].RootDirectory = "/unexpected-root";
  const ledger = createUnitLedger(f.config, "matrix-native-token", { observe: async (name: string) => f.state[name], mutate: async (_: string, name: string) => { stopped.push(name); } });
  ledger.submitted(); await ledger.captureSupervisor(); const handle = `runtime_${"a".repeat(32)}`;
  await ledger.recordWorker({ runtimeHandle: handle, executionGeneration: "1" });
  const journal = createJournal(); await expect(journal.resourceStep(handle, "sdk", async () => { throw Error("security_property_drift"); })).rejects.toThrow();
  f.state[f.worker].DefinitionIdentity = "security-property-update-same-incarnation";
  expect((await ledger.cleanup()).every((entry: {state: string}) => entry.state === "passed")).toBe(true);
  expect(stopped).toEqual([f.supervisor, f.worker]); expect(journal.result().resources[handle].state).toBe("failed");
});

it("ties observed supervisor and worker executables to the reviewed source object and SHA256", async () => {
  const { executableEvidence, verifyExecutableEvidence } = await import("../../scripts/ops/devstack-native/node-evidence.mjs");
  const dir = await fixture(), first = join(dir, "first"), other = join(dir, "other");
  await writeFile(first, "same"); await writeFile(other, "same");
  const reviewed = await executableEvidence(first);
  expect(await verifyExecutableEvidence(first, reviewed)).toEqual(reviewed);
  await expect(verifyExecutableEvidence(other, reviewed)).rejects.toThrow("node_executable_mismatch");
  await writeFile(first, "changed");
  await expect(verifyExecutableEvidence(first, reviewed)).rejects.toThrow("node_executable_mismatch");
});

it("refuses a replaced guest executable despite a matching manager mapping and live worker image", async () => {
  const { withVerifiedWorkerNode, executableEvidence } = await import("../../scripts/ops/devstack-native/node-evidence.mjs");
  const { validateWorkerProperties } = await import("../../scripts/ops/devstack-native/security.mjs");
  const f = profileFixture();
  expect(() => validateWorkerProperties(f.properties, f.config, f.handle, f.deps)).not.toThrow();
  const dir = await fixture(), host = join(dir, "source"), running = join(dir, "exe"), guest = join(dir, "guest");
  await writeFile(host, "approved"); await link(host, running); await link(host, guest);
  const expected = await executableEvidence(host), run = vi.fn();
  await rm(guest); await writeFile(guest, "approved");
  await expect(withVerifiedWorkerNode({ host, running, guest }, expected, run)).rejects.toThrow("node_executable_mismatch");
  expect(run).not.toHaveBeenCalled();
});

it("pins the reviewed guest inode while running the probe and rejects replacement during execution", async () => {
  const { withVerifiedWorkerNode, executableEvidence } = await import("../../scripts/ops/devstack-native/node-evidence.mjs");
  const dir = await fixture(), host = join(dir, "source"), running = join(dir, "exe"), guest = join(dir, "guest");
  await writeFile(host, "approved"); await link(host, running); await link(host, guest);
  const expected = await executableEvidence(host);
  const run = vi.fn(async (file: import("node:fs/promises").FileHandle) => {
    await rm(guest); await writeFile(guest, "different");
    expect(String((await file.stat({ bigint: true })).ino)).toBe(expected.inode);
    return "untrusted-result";
  });
  await expect(withVerifiedWorkerNode({ host, running, guest }, expected, run)).rejects.toThrow("node_executable_mismatch");
  expect(run).toHaveBeenCalledOnce();
});

it("passes the verified file descriptor to the namespaced probe executable", async () => {
  const { executableEvidence, runPinnedDenialProbe, withVerifiedWorkerNode } = await import("../../scripts/ops/devstack-native/node-evidence.mjs");
  const dir = await fixture(), host = join(dir, "source");
  await writeFile(host, "pinned source");
  const node = await executableEvidence(host);
  const child = (command: string, args: string[], options: SpawnOptions) => {
    expect(command).toBe("/usr/bin/nsenter");
    expect(args.slice(0, args.indexOf("--") + 2)).toEqual(["--target=42", "--mount", "--net", "--root", "--wd",
      "--setuid=61184", "--setgid=61184", "--", "/proc/self/fd/3"]);
    // Exercise the real inherited fd using a portable child instead of entering a Linux namespace.
    return spawn(process.execPath, ["-e", "process.stdout.write(String(require('node:fs').fstatSync(3, {bigint:true}).ino))"], options);
  };
  const observed = await withVerifiedWorkerNode({ host, running: host, guest: host }, node, (file: import("node:fs/promises").FileHandle) =>
    runPinnedDenialProbe(file, { pid: 42, uid: 61184, gid: 61184 }, "{}", child));
  expect(observed.result).toBe(node.inode);
});
