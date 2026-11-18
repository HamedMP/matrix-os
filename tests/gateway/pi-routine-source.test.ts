import { expect, it } from "vitest";
import { createChatRoutineSourceProducer } from "../../packages/gateway/src/chat/routine-chat-source.js";
import type { CanonicalProviderRunInput } from "../../packages/gateway/src/chat/provider-adapter.js";

it("admits actual native Pi without borrowing managed Pi or another native driver", () => {
  const input: CanonicalProviderRunInput = { owner: { type: "personal", ownerId: "user_owner_1" }, chatId: "chat_pi", runId: "run_pi", turnId: "turn_pi",
    selection: { instanceId: "pi_default", model: "fixture-model" }, prompt: "Fixture", parts: [{ type: "text", text: "Fixture" }], permissionMode: "supervised", interactionMode: "default", signal: new AbortController().signal };
  const source = createChatRoutineSourceProducer({ input, provider: "pi", computerId: "computer_one", signal: input.signal, current: () => true, publish() {} });
  expect(source.producer.source.harness).toBe("pi");
  expect(source.producer.source.identity).toMatchObject({ kind: "chat_run", route: "native", chatId: "chat_pi", runId: "run_pi" });
  expect(source.producer.readPolicy()).toMatchObject({ permissionMode: "supervised", originCeiling: "exact" });
});

import { createPiOwnedExtension } from "../../packages/gateway/src/coding-agents/pi-owned-extension.js";
import { pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";
it("stages a builtin-only owned native routine descriptor using the authoritative operation schema", async () => {
  const extension = await createPiOwnedExtension({ routines: true });
  try {
    expect(extension.routinePath).toEqual(expect.any(String));
    const tools: Array<{ name: string; parameters: unknown }> = [];
    const loaded = await import(pathToFileURL(extension.routinePath!).href);
    loaded.default({ registerTool: (tool: { name: string; parameters: unknown }) => tools.push(tool) });
    expect(tools.map(tool => tool.name)).toEqual(["matrix_routines"]);
    expect(JSON.stringify(tools[0].parameters)).toContain('"operation"');
    expect(await readFile(extension.path, "utf8")).toContain('name: "ask_user"');
  } finally { await extension.dispose(); }
});

import { Duplex } from "node:stream";
import { afterEach, vi } from "vitest";
import { createPiRoutineSources, nativePiRoutineSource } from "../../packages/gateway/src/chat/pi-routine-source.js";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); vi.useRealTimers(); });
// Registration sentinel is a negative-only boundary fixture. Positive authority uses the required PG lane.
function boundaryFixture() {
  const input: CanonicalProviderRunInput = { owner: { type: "personal", ownerId: "user_owner_1" }, chatId: "chat_pi", runId: "run_pi", turnId: "turn_pi",
    selection: { instanceId: "pi_default", model: "fixture-model" }, prompt: "Fixture", parts: [{ type: "text", text: "Fixture" }], permissionMode: "supervised", interactionMode: "default", signal: new AbortController().signal };
  const register = vi.fn(async () => { throw new Error("Named registration-boundary fixture"); });
  const held = createPiRoutineSources({ binPath: "/fixture/matrix.mjs", endpoint: "http://127.0.0.1:4000/api/routine-cli/execute", runtime: { registerChat: register } }, "/fixture").open(input, () => {})!;
  cleanups.push(() => held.close());
  const source = held.withContext(() => nativePiRoutineSource()!);
  const results: Array<{ id: string; result: string }> = [];
  const pipe = new Duplex({ read() {}, write(chunk, _encoding, done) { results.push(JSON.parse(chunk.toString())); done(); } });
  source.attach(pipe); source.beforePrompt("session_owned", "/fixture");
  const id = (n: number) => "de000000-0000-4000-8000-" + String(n).padStart(12, "0");
  return { source, register, results, pipe,
    callback(toolCallId = "call_owned", n = 1) { pipe.emit("data", Buffer.from(JSON.stringify({ type: "call", id: id(n), context: { sessionId: "session_owned", toolCallId }, operation: { operation: "list" } }) + "\n")); },
    cancel(n = 1) { pipe.emit("data", Buffer.from(JSON.stringify({ type: "cancel", id: id(n) }) + "\n")); },
    event(type: string, toolCallId = "call_owned") { source.observeEvent({ type, toolName: "matrix_routines", toolCallId, args: { operation: "list" } }); },
    start() { source.observeEvent({ type: "agent_start" }); source.observeEvent({ type: "turn_start" }); },
  };
}
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
it("FD-first receives no authority until the current actual native turn/call observation", async () => {
  const f = boundaryFixture(); f.callback(); await turn(); expect(f.register).not.toHaveBeenCalled(); expect(f.results).toEqual([]);
  f.start(); await turn(); expect(f.register).not.toHaveBeenCalled(); f.event("tool_execution_start"); await turn(); expect(f.register).toHaveBeenCalledOnce();
});
it.each(["terminal first", "turn ended"])("%s permanently retires that call even if running is observed later", async ending => {
  const f = boundaryFixture(); f.start();
  if (ending === "terminal first") f.event("tool_execution_end"); else { f.event("tool_execution_start"); f.event("turn_end"); f.event("turn_start"); }
  f.event("tool_execution_start"); f.callback(); await turn(); expect(f.register).not.toHaveBeenCalled(); expect(f.source.current()).toBe(true);
});
it.each(["cancel", "timeout", "source end", "expiry", "FD EOF", "terminal"])("rendezvous %s cannot acquire late authority", async ending => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const f = boundaryFixture(); f.start(); f.callback();
  if (ending === "cancel") f.cancel(); else if (ending === "timeout") await vi.advanceTimersByTimeAsync(2100);
  else if (ending === "source end") f.source.end(); else if (ending === "expiry") await vi.advanceTimersByTimeAsync(30 * 60_000);
  else if (ending === "FD EOF") f.pipe.emit("end"); else f.event("tool_execution_end");
  f.event("tool_execution_start"); await turn(); expect(f.register).not.toHaveBeenCalled();
  expect(f.source.current()).toBe(!["source end", "expiry", "FD EOF"].includes(ending));
});
it("counts observation waits toward eight active calls and retains replay fences after timeout", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const f = boundaryFixture(); f.start(); for (let n = 1; n <= 9; n++) f.callback("call_" + n, n);
  expect(f.register).not.toHaveBeenCalled(); expect(f.results).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(2100); expect(f.results).toHaveLength(9);
  f.event("tool_execution_start", "call_9"); f.callback("call_9", 10); await turn(); expect(f.register).not.toHaveBeenCalled(); expect(f.results).toHaveLength(10);
});

import { chmod, lstat, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
it("owned extension cleanup removes expired finite files while preserving symlinks and live leases", async () => {
  const first = await createPiOwnedExtension({ routines: true });
  const root = dirname(dirname(first.path));
  const outside = await mkdtemp(join(tmpdir(), "matrix-pi-cleanup-test-"));
  let second: Awaited<ReturnType<typeof createPiOwnedExtension>> | undefined;
  const stale = await mkdtemp(join(root, "run-")), unsafe = await mkdtemp(join(root, "run-"));
  const old = new Date(Date.now() - 32 * 60_000);
  try {
    expect((await lstat(first.path)).mode & 0o777).toBe(0o600);
    expect((await lstat(dirname(first.path))).mode & 0o777).toBe(0o700);
    await writeFile(join(stale, ".lease"), "", { flag: "wx", mode: 0o600 });
    await writeFile(join(stale, "routines.mjs"), "stale", { flag: "wx", mode: 0o600 }); await utimes(join(stale, ".lease"), old, old);
    await writeFile(join(unsafe, ".lease"), "", { flag: "wx", mode: 0o600 });
    await writeFile(join(outside, "preserved"), "owner", { flag: "wx", mode: 0o600 });
    await symlink(join(outside, "preserved"), join(unsafe, "routines.mjs")); await utimes(join(unsafe, ".lease"), old, old);
    await chmod(stale, 0o700); await chmod(unsafe, 0o700);
    second = await createPiOwnedExtension({ routines: true });
    await expect(lstat(stale)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await lstat(join(unsafe, "routines.mjs"))).isSymbolicLink()).toBe(true);
    expect(await readFile(join(outside, "preserved"), "utf8")).toBe("owner");
    expect(await readFile(first.path, "utf8")).toContain('name: "ask_user"');
  } finally { await first.dispose(); await second?.dispose(); await rm(stale, { recursive: true, force: true }); await rm(unsafe, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
  await expect(lstat(dirname(first.path))).rejects.toMatchObject({ code: "ENOENT" });
});

// Failure injection stays at the real FS write; every other allocation/stat/sweep/removal is actual.
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, writeFile: vi.fn(actual.writeFile) };
});
vi.mock("node:os", async importOriginal => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, tmpdir: vi.fn(actual.tmpdir) };
});
import { mkdir, readdir } from "node:fs/promises";

async function isolatedExtensionRoot() {
  const realTmpdir = tmpdir(), sandbox = await mkdtemp(join(realTmpdir, "matrix-pi-orphan-test-"));
  vi.mocked(tmpdir).mockReturnValue(sandbox);
  const root = join(sandbox, `matrix-pi-extensions-${process.getuid?.() ?? "user"}`);
  return { root, async close() { vi.mocked(tmpdir).mockReturnValue(realTmpdir); await rm(sandbox, { recursive: true, force: true }); } };
}
it("owned extension setup failure at lease write removes its unreturned directory", async () => {
  const fixture = await isolatedExtensionRoot();
  const failure = Object.assign(new Error("Injected lease write failure"), { code: "EACCES" });
  let allocated: string | undefined, ordinary: Awaited<ReturnType<typeof createPiOwnedExtension>> | undefined;
  vi.mocked(writeFile).mockImplementationOnce(async path => { allocated = dirname(String(path)); throw failure; });
  try {
    await expect(createPiOwnedExtension()).rejects.toBe(failure);
    expect(allocated).toEqual(expect.any(String));
    await expect(lstat(allocated!)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(fixture.root)).toEqual([]);
    ordinary = await createPiOwnedExtension();
    expect(await readFile(ordinary.path, "utf8")).toContain('name: "ask_user"');
  } finally { await ordinary?.dispose(); await fixture.close(); }
});
it("owned extension reclaims aged lease-less orphan capacity while keeping fresh initialization, live lease and symlink targets", async () => {
  const fixture = await isolatedExtensionRoot(), outside = await mkdtemp(join(tmpdir(), "outside-"));
  const old = new Date(Date.now() - 32 * 60_000);
  let ordinary: Awaited<ReturnType<typeof createPiOwnedExtension>> | undefined;
  try {
    await mkdir(fixture.root, { mode: 0o700 });
    const orphans: string[] = [];
    for (let n = 0; n < 128; n++) {
      const path = await mkdtemp(join(fixture.root, "run-")); orphans.push(path);
      if (n === 0) await writeFile(join(path, "ask-user.ts"), "incomplete owned stage", { mode: 0o600, flag: "wx" });
      await utimes(path, old, old);
    }
    const initializing = await mkdtemp(join(fixture.root, "run-")), live = await mkdtemp(join(fixture.root, "run-"));
    await writeFile(join(live, ".lease"), "", { mode: 0o600, flag: "wx" }); await utimes(live, old, old);
    await writeFile(join(outside, "preserved"), "owner", { mode: 0o600, flag: "wx" });
    const link = join(fixture.root, "run-LINK00"); await symlink(outside, link);
    ordinary = await createPiOwnedExtension();
    for (const path of orphans) await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await lstat(initializing)).isDirectory()).toBe(true);
    expect((await lstat(live)).isDirectory()).toBe(true);
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readFile(join(outside, "preserved"), "utf8")).toBe("owner");
    expect(await readFile(ordinary.path, "utf8")).toContain('name: "ask_user"');
    expect(ordinary.routinePath).toBeUndefined();
  } finally { await ordinary?.dispose(); await fixture.close(); }
});
it("owned extension sweep preserves an in-process initialization even beyond the orphan grace", async () => {
  const fixture = await isolatedExtensionRoot(), actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  let release!: () => void, entered!: (directory: string) => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), allocated = new Promise<string>(resolve => { entered = resolve; });
  vi.mocked(writeFile).mockImplementationOnce(async (path, data, options) => {
    entered(dirname(String(path))); await gate; return actual.writeFile(path, data, options);
  });
  const pending = createPiOwnedExtension();
  let initializing: Awaited<ReturnType<typeof createPiOwnedExtension>> | undefined, other: Awaited<ReturnType<typeof createPiOwnedExtension>> | undefined;
  try {
    const path = await allocated, old = new Date(Date.now() - 32 * 60_000); await utimes(path, old, old);
    other = await createPiOwnedExtension(); expect((await lstat(path)).isDirectory()).toBe(true);
    release(); initializing = await pending;
    expect(await readFile(initializing.path, "utf8")).toContain('name: "ask_user"');
  } finally { release(); await Promise.allSettled([pending.then(value => value.dispose())]); await other?.dispose(); await fixture.close(); }
});
