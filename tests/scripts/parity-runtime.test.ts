import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { startQemuRuntime, runtimeProcessPids, runtimeProcessIsOwned, waitForRuntimeSsh, waitForRuntimeReadiness, runRuntimeSshProbe } from "../../scripts/local-production-parity/runtime.mjs";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), spawnSync: vi.fn(), writeFileSync: vi.fn() }));
vi.mock("node:child_process", async () => ({ ...await vi.importActual("node:child_process"), ...mocks }));
vi.mock("node:fs", async () => ({ ...await vi.importActual("node:fs"), openSync: () => 42, closeSync: () => {}, writeFileSync: mocks.writeFileSync }));
afterEach(() => vi.clearAllMocks());

it("does not mistake similarly named disks or other commands for the retained VM", () => {
  const diskPath = "/checkout/runtime/disk.qcow2";
  const exact = `qemu-system-x86_64 -drive if=virtio,file=${diskPath} -m 4096`;
  const backup = exact.replace("disk.qcow2", "disk.qcow2.backup");
  expect(runtimeProcessPids({ diskPath, processList: () => `41 ${backup}\n42 ${exact}\n43 echo ${exact}` })).toEqual([42]);
  expect(runtimeProcessIsOwned({ pid: 41, diskPath, processCommand: () => backup })).toBe(false);
});

it("detaches and unreferences the retained VM so launcher shutdown releases its lock", () => {
  const unref = vi.fn();
  mocks.spawnSync.mockReturnValue({ status: 0, stdout: "/fixture/qemu-system-x86_64\n" });
  mocks.spawn.mockReturnValue({ pid: 321, unref });
  startQemuRuntime();
  expect(unref).toHaveBeenCalledOnce();
  expect(mocks.spawn.mock.calls[0][2].detached).toBe(true);
  expect(mocks.writeFileSync).toHaveBeenCalledWith(expect.any(String), "321\n", { mode: 0o600 });
});

it.each([waitForRuntimeSsh, waitForRuntimeReadiness])("bounds each readiness probe by the remaining deadline", async (wait) => {
  const probe = vi.fn(async (_args: string[], _options: { timeoutMs: number }) => true);
  mocks.spawnSync.mockReturnValue({ status: 0 });
  await wait(100, undefined, { probe });
  expect(probe).toHaveBeenCalledOnce();
  expect(probe.mock.calls[0][1].timeoutMs).toBeGreaterThan(0);
  expect(probe.mock.calls[0][1].timeoutMs).toBeLessThanOrEqual(100);
});

it("terminates a stalled SSH child on timeout and cancellation", async () => {
  const execute = (_command: string, _args: string[], options: object) => promisify(execFile)(process.execPath, ["-e", "setInterval(() => {}, 1000)"], options);
  await expect(runRuntimeSshProbe(["true"], { timeoutMs: 30, execute })).resolves.toBe(false);
  const controller = new AbortController();
  const pending = runRuntimeSshProbe(["true"], { timeoutMs: 5000, signal: controller.signal, execute });
  controller.abort(new Error("fixture cancellation"));
  await expect(pending).rejects.toThrow("fixture cancellation");
});
