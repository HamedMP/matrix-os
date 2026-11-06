import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("lets the legacy exec runner finish without registering a ten-minute whole-turn kill", async () => {
  const directory = await mkdtemp(join(tmpdir(), "legacy-codex-long-"));
  const preload = join(directory, "clock.mjs");
  const provider = join(directory, "provider.mjs");
  const events = join(directory, "events.jsonl");
  // Accelerate only the old ten-minute deadline in the runner. The synthetic
  // child performs no model request and completes after that accelerated bound.
  await writeFile(preload, 'const original = globalThis.setTimeout; globalThis.setTimeout = (callback, ms, ...args) => original(callback, ms === 600000 ? 1 : ms, ...args);\n');
  await writeFile(provider, 'await new Promise(resolve => setTimeout(resolve, 30)); console.log(JSON.stringify({type:"thread.started",thread_id:"synthetic_thread"})); console.log(JSON.stringify({type:"turn.completed"}));\n');
  try {
    const pending = promisify(execFile)(process.execPath, ["--import", preload,
      join(process.cwd(), "packages/gateway/src/coding-agents/codex-runner.mjs"), events,
      process.version.slice(1), process.execPath, provider, "exec", "--json", "--", "Synthetic answer"],
      { cwd: directory, timeout: 5_000, maxBuffer: 64 * 1024 });
    pending.child.stdin?.end();
    const result = await pending;
    expect(result.stderr).toBe("");
    const types = (await readFile(events, "utf8")).trim().split("\n").map(line => JSON.parse(line).type);
    expect(types).toContain("turn.completed");
    expect(types).not.toContain("turn.failed");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
