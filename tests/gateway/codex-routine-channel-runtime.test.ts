import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { expect, it } from "vitest";

it("a raw native routine call has no source and receives a safe unavailable result while ordinary work completes", async () => {
  const dir = await mkdtemp("/tmp/codex-routine-denied-");
  const records = join(dir, "native.jsonl"), fixture = join(dir, "fixture.json"), events = join(dir, "events.jsonl");
  await writeFile(fixture, JSON.stringify({ records }));
  const config = Buffer.from(JSON.stringify({ prompt: "Fixture", approvalPolicy: "never", sandbox: "workspace-write", writableRoots: [dir] })).toString("base64");
  const child = spawn(process.execPath, [resolve("packages/gateway/src/coding-agents/codex-app-server-runner.mjs"), events, process.version.slice(1), process.execPath, resolve("tests/fixtures/codex-routine-process.mjs"), config], {
    cwd: dir, env: { ...process.env, TEST_ROUTINE_NATIVE_FILE: fixture }, stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.resume(); child.stderr.resume();
  const closed = new Promise<number | null>((done, reject) => { child.once("error", reject); child.once("close", done); });
  try {
    expect(await closed).toBe(0);
    const frames = (await readFile(records, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(frames.find(frame => frame.id === 107)).toEqual({ id: 107, result: { success: false, contentItems: [{ type: "inputText", text: JSON.stringify({ v: 1, error: { code: "unavailable", message: "Routine requests are temporarily unavailable." } }) }] } });
    expect(frames.find(frame => frame.method === "thread/start").params).not.toHaveProperty("dynamicTools");
    expect(await readFile(events, "utf8")).toContain('"type":"turn.completed"');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed; await rm(dir, { recursive: true, force: true });
  }
}, 15_000);
