import { spawn, type ChildProcess } from "node:child_process";
import { afterEach, expect, it } from "vitest";
import { runInRuntimeAsync } from "../../scripts/dev-production-parity.mjs";

const children: ChildProcess[] = [];
afterEach(() => { for (const child of children.splice(0)) child.kill("SIGKILL"); });

function stalledSsh(_command: string, _args: string[], options: object) {
  const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { ...options, stdio: "ignore" });
  children.push(child);
  return child;
}

it("kills stalled cloud-init SSH at its deadline and rejects startup", async () => {
  const pending = runInRuntimeAsync(["sudo", "cloud-init", "status", "--wait"], undefined,
    { timeoutMs: 40, spawnProcess: stalledSsh });
  let watchdog: ReturnType<typeof setTimeout>;
  try {
    const bounded = Promise.race([pending, new Promise((_, reject) => {
      watchdog = setTimeout(() => reject(new Error("SSH exceeded test deadline")), 1000);
    })]);
    await expect(bounded).rejects.toThrow(/SIGKILL/);
    expect(children[0].signalCode).toBe("SIGKILL");
  } finally { clearTimeout(watchdog!); }
});

it("rejects an already cancelled startup without spawning SSH", async () => {
  const controller = new AbortController();
  controller.abort(new Error("startup cancelled"));
  await expect(runInRuntimeAsync(["true"], controller.signal, { spawnProcess: stalledSsh }))
    .rejects.toThrow("startup cancelled");
  expect(children).toHaveLength(0);
});

it("kills SSH when startup is cancelled in flight", async () => {
  const controller = new AbortController();
  const pending = runInRuntimeAsync(["true"], controller.signal,
    { timeoutMs: 1000, spawnProcess: stalledSsh });
  controller.abort();
  await expect(pending).rejects.toThrow(/abort/i);
  const child = children[0];
  await new Promise<void>(resolve => child.once("close", () => resolve()));
  expect(child.signalCode).toBe("SIGKILL");
});
