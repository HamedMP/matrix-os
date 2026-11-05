import { chmod, link, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveScopeRuntimeHostConfig } from "../../packages/scope-runtime/src/host-config.js";

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
    expect(() => resolveConfig(parseOptions(args), resolveScopeRuntimeHostConfig)).not.toThrow();
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

  it("preflight never creates directories, marker, units or receipt", async () => {
    const { preflight } = await subject(); const f = await fixture(true);
    const before = await readdir(f.root);
    const commands: string[][] = [];
    const config = resolveScopeRuntimeHostConfig({ env: { MATRIX_SCOPE_RUNTIME_NAMESPACE: "proof", MATRIX_SCOPE_RUNTIME_APP_ROOT: "/var/lib/matrix-devstack/proof/app", MATRIX_HOME: "/var/lib/matrix-devstack/proof/home" } });
    Object.assign(config, { runtimeDirectory: join(f.root, "run", "scope-runtime"), commandSocketRoot: join(f.root, "run", "c"), stateRoot: join(f.root, "state", "scope-runtime"), appRoot: join(f.root, "app") });
    const result = await preflight(config, async (_bin: string, argv: string[]) => { commands.push(argv); return { code: 0, stdout: argv.includes("show") ? "LoadState=not-found\n" : "" }; });
    expect(result.ready).toBe(false); expect(await readdir(f.root)).toEqual(before);
    expect(commands).toHaveLength(3);
    expect(commands.every(argv => ["show", "list-units", "list-unit-files"].includes(argv[0]))).toBe(true);
    expect(await readFile(f.path, "utf8")).toContain('"namespace":"proof"');
  });

  it("refuses inactive foreign units and ambiguous partial state", async () => {
    const { assertVacant } = await subject();
    const config = { supervisorUnit: "matrix-devstack-proof-scope-runtime.service", workerUnitPrefix: "matrix-devstack-proof-scope-runtime-", runtimeDirectory: "/nonexistent-native-proof/r", commandSocketRoot: "/nonexistent-native-proof/c", stateRoot: "/nonexistent-native-proof/s" };
    await expect(assertVacant(config, async () => ({ code: 0, stdout: "LoadState=loaded\nActiveState=inactive\n" }))).rejects.toThrow(/unit/);
    const f = await fixture();
    await expect(assertVacant({ ...config, stateRoot: f.root }, async (_: string, argv: string[]) => ({ code: 0, stdout: argv[0] === "show" ? "LoadState=not-found\n" : "" }))).rejects.toThrow(/state/);
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
    const config = resolveScopeRuntimeHostConfig({ env: { MATRIX_SCOPE_RUNTIME_NAMESPACE: "proof", MATRIX_SCOPE_RUNTIME_APP_ROOT: "/var/lib/matrix-devstack/proof/app", MATRIX_HOME: "/var/lib/matrix-devstack/proof/home" } });
    const result = supervisorArgs(config, "matrix-native-proof-token", template);
    expect(result).toContain("--property=StandardError=append:/var/lib/matrix-devstack/proof/.matrix-native-proof-token.stderr");
    expect(result).toContain("--property=LimitFSIZE=65536");
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
  const discover = async (_: string, argv: string[]) => ({ code: 0, stdout: argv[0] === "show" ? "LoadState=not-found" : "" });
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
