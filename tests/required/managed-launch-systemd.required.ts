import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { managedLaunchOverflow } from "../helpers/managed-launch-overflow.js";
import { access, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { buildAgentLaunch } from "../../packages/gateway/src/agent-launcher.js";
import { createBackgroundAgentRuntime } from "../../packages/gateway/src/background-agent-runtime.js";
import type { ManagedLaunchChannel } from "../../packages/gateway/src/background-launch-channel.js";
import type { ManagedShimFrame } from "../../packages/gateway/src/coding-agents/managed-launch-protocol.mjs";

it.each(["Gateway close", "wrapper protocol close", "wrapper output overflow"] as const)("qualifies actual systemd --pipe %s and retains native/service life", async ending => {
  const uid = process.getuid?.();
  if (process.platform !== "linux" || uid === undefined || uid === 0) throw new Error("Required Linux nonroot systemd user-manager prerequisite is missing; transport UNQUALIFIED");
  try { await Promise.all(["/usr/bin/systemd-run", "/usr/bin/systemctl", "/usr/bin/flock", `/run/user/${uid}/bus`].map(path => access(path))); }
  catch (error) { throw new Error("Required systemd --pipe/user-bus prerequisite is missing; transport UNQUALIFIED", { cause: error }); }
  const home = await mkdtemp("/tmp/ml-");
  const overflow = ending === "wrapper output overflow" ? await managedLaunchOverflow(home) : undefined;
  let retained: ChildProcessWithoutNullStreams | undefined;
  const runtime = createBackgroundAgentRuntime({ homePath: home, spawnPrivate(command, args, options) {
    const at = args.indexOf("--") + 1;
    const forwarded = overflow ? [...args.slice(0, at + 1), "--import", overflow.preload, ...args.slice(at + 1)] : args;
    retained = spawn(command, forwarded, { env: options.env, stdio: options.stdio }); return retained;
  } }), observer = createBackgroundAgentRuntime({ homePath: home });
  let ref: Awaited<ReturnType<typeof runtime.start>> | undefined, channel: ManagedLaunchChannel | undefined;
  try {
    const config = join(home, "fixture.json"), executable = join(home, "named-native-fixture.mjs");
    await writeFile(config, JSON.stringify({ records: join(home, "native.jsonl"), controlFile: join(home, "native-control"), holdAfterResult: true }));
    await writeFile(executable, `#!${process.execPath}\nif (process.argv.includes('--version')) console.log('codex 0.162.1'); else { process.env.TEST_ROUTINE_NATIVE_FILE = ${JSON.stringify(config)}; await import(${JSON.stringify(pathToFileURL(resolve("tests/fixtures/codex-routine-process.mjs")).href)}); }\n`);
    await chmod(executable, 0o700);
    const launch = buildAgentLaunch({ agent: "codex", cwd: home, prompt: "Named transport fixture", runtimeHome: home, codexExecutable: executable,
      providerEventPath: join(home, "events.jsonl"), codexRoutinePrivate: true, sandbox: { enabled: true, writableRoots: [home] } });
    let revoke!: () => void; const revoked = new Promise<void>(done => { revoke = done; });
    let receive!: (value: Extract<ManagedShimFrame, { type: "shim.call" }>) => void;
    const call = new Promise<Extract<ManagedShimFrame, { type: "shim.call" }>>(resolve => { receive = resolve; });
    ref = await runtime.start({ sessionId: "sess_systemd_required", launch, privateControl: { onReady(actual) {
      channel = actual; actual.subscribe(frame => { if (frame.type === "shim.call") receive(frame); }, revoke);
      actual.send({ type: "host.turn", first: true, admissionId: "00000000-0000-4000-8000-000000000001" });
    } } });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const frame = await Promise.race([call, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Actual systemd private turn was not observed")), 10000); })]).finally(() => clearTimeout(timer));
    expect(frame.intent).toEqual({ args: ["list"] }); expect(frame.admissionId).toBe("00000000-0000-4000-8000-000000000001");
    if (ending === "Gateway close") channel!.close();
    else if (ending === "wrapper protocol close") retained!.stdin.write("{}\n");
    else { await overflow!.trigger(); await writeFile(join(home, "native-control"), "overflow"); }
    await Promise.race([revoked, new Promise<never>((_done, reject) => { timer = setTimeout(() => reject(new Error("Actual systemd wrapper-output teardown did not fence Gateway; transport UNQUALIFIED")), 10000); })]).finally(() => clearTimeout(timer));
    // This must use actual manager FDs: direct Node/PassThrough closure cannot qualify duplicates held by systemd.
    await expect.poll(async () => (await readFile(join(home, "native.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line)).find(frame => frame.id === 107)?.result, { timeout: 3000 }).toMatchObject({ success: false });
    await writeFile(join(home, "native-control"), "after-overflow");
    await expect.poll(async () => (await readFile(join(home, "native.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line)).find(frame => frame.id === 109)?.result, { timeout: 3000 }).toMatchObject({ success: false });
    expect(await observer.isRunning(ref)).toBe(true); // Pipe loss revokes routines; it cannot kill native/service/profile ownership.
    expect(channel!.send({ type: "host.turn", first: true, admissionId: "00000000-0000-4000-8000-000000000002" })).toBe(false);
  } finally {
    if (ref) await observer.stop(ref);
    await runtime.close(); await observer.close(); await rm(home, { recursive: true, force: true });
  }
});
