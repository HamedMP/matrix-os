import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUsageSyncService } from "../../desktop/src/main/usage-sync/service";
import { transferUsageHistory } from "../../desktop/src/main/usage-sync/transfer";
import { registerAiUsageIpc } from "../../desktop/src/main/ipc/ai-usage";
import { runSyncProcess } from "../../desktop/src/main/usage-sync/process";
const pairing = {
  version: 1 as const,
  ownerId: "owner",
  runtimeSlot: "primary",
  gatewayOrigin: "https://matrix.example",
  sshHost: "matrix-test",
  backupRoot: "/home/matrix/home/backups/test",
  checkout: "/home/matrix/home/dev/checkout",
  databaseEnv: "/home/matrix/home/private/usage.env",
};
afterEach(() => vi.useRealTimers());
it("terminates the real transfer child when shutdown aborts it", async () => {
  const abort = new AbortController();
  const task = runSyncProcess(
    process.execPath,
    ["-e", "setInterval(()=>{},1000)"],
    abort.signal,
  );
  abort.abort();
  await expect(task).rejects.toThrow();
});
it("does not transfer for an unpaired Mac or a pairing belonging to another owner", async () => {
  const auth = {
    getStatus: () => ({
      signedIn: true,
      userId: "owner",
      runtimeSlot: "primary",
      authGeneration: 1,
    }),
    getGatewayOrigin: () => pairing.gatewayOrigin,
  };
  const transfer = vi.fn();
  const service = createUsageSyncService({
    home: "/mac",
    pairingFile: "/private",
    auth,
    readPairing: async () => null,
    transfer,
  });
  expect(
    await service.sync({
      runtimeSlot: "primary",
      authGeneration: 1,
      force: true,
    }),
  ).toEqual({ status: "unpaired" });
  await service.dispose();
  const other = createUsageSyncService({
    home: "/mac",
    pairingFile: "/private",
    auth,
    readPairing: async () => ({ ...pairing, ownerId: "other" }),
    transfer,
  });
  await expect(
    other.sync({ runtimeSlot: "primary", authGeneration: 1, force: true }),
  ).rejects.toThrow();
  await other.dispose();
  expect(transfer).not.toHaveBeenCalled();
});
it("manual Refresh invokes the same trusted native sync as the hourly worker; arbitrary renderer paths are rejected", async () => {
  const handlers = new Map<
    string,
    (event: unknown, input: unknown) => Promise<unknown>
  >();
  const sync = {
    sync: vi.fn(async () => ({
      status: "synced" as const,
      syncedAt: new Date().toISOString(),
    })),
    cancel: vi.fn(),
    dispose: vi.fn(async () => {}),
  };
  const service = registerAiUsageIpc(
    { handle: (name, fn) => handlers.set(name, fn) },
    {
      home: "/local",
      auth: {
        getStatus: () => ({
          signedIn: true,
          userId: "owner",
          runtimeSlot: "primary",
          authGeneration: 1,
        }),
      },
      isTrusted: (event) => event === "trusted",
      sync,
    } as never,
  );
  expect(handlers.has("runtime:ai-usage-sync")).toBe(true);
  const handler = handlers.get("runtime:ai-usage-sync")!;
  await expect(
    handler("foreign", { runtimeSlot: "primary", authGeneration: 1 }),
  ).rejects.toThrow();
  await expect(
    handler("trusted", {
      runtimeSlot: "primary",
      authGeneration: 1,
      path: "/private",
    }),
  ).rejects.toThrow();
  expect(sync.sync).not.toHaveBeenCalled();
  await handler("trusted", { runtimeSlot: "primary", authGeneration: 1 });
  expect(sync.sync).toHaveBeenCalledOnce();
  await service.dispose();
  expect(sync.dispose).toHaveBeenCalledOnce();
});
it("syncs while the app is open without a Settings view, coalesces Refresh, and cancels on sign-out", async () => {
  vi.useFakeTimers();
  let signedIn = true;
  let finish!: () => void;
  let signal!: AbortSignal;
  const transfer = vi.fn(async (_p, _h, s) => {
    signal = s;
    await new Promise<void>((r) => {
      finish = r;
    });
  });
  const service = createUsageSyncService({
    home: "/mac",
    pairingFile: "/private/config",
    auth: {
      getStatus: () => ({
        signedIn,
        userId: "owner",
        runtimeSlot: "primary",
        authGeneration: 1,
      }),
      getGatewayOrigin: () => pairing.gatewayOrigin,
    },
    readPairing: async () => pairing,
    transfer,
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(transfer).toHaveBeenCalledOnce();
  const manual = service.sync({ runtimeSlot: "primary", authGeneration: 1 });
  expect(transfer).toHaveBeenCalledOnce();
  finish();
  await manual;
  await vi.advanceTimersByTimeAsync(60 * 60 * 1000 - 1);
  expect(transfer).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1);
  expect(transfer).toHaveBeenCalledTimes(2);
  signedIn = false;
  service.cancel();
  expect(signal.aborted).toBe(true);
  finish();
  await Promise.resolve();
  await service.dispose();
  await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000);
  expect(transfer).toHaveBeenCalledTimes(2);
});
it("backs up only allowlisted history, preserves changed versions, then waits for Matrix verification/indexing", async () => {
  const home = await mkdtemp(join(tmpdir(), "usage-sync-"));
  try {
    await mkdir(join(home, ".codex", "sessions"), { recursive: true });
    await writeFile(join(home, ".codex", "auth.json"), "private");
    await writeFile(join(home, ".codex", "sessions", "one.jsonl"), "{}\n");
    const run = vi.fn(async () => {});
    await transferUsageHistory(
      pairing,
      home,
      new AbortController().signal,
      run,
    );
    expect(run.mock.calls.map((c) => c[0])).toEqual(["ssh", "rsync", "ssh"]);
    const args = run.mock.calls[1][1] as string[];
    expect(args.at(-1)).toContain("/incoming/auto-");
    expect(args.some((arg) => arg.startsWith("--link-dest="))).toBe(true);
    expect(args).toContain("--no-links");
    expect(args).not.toContain("--delete");
    expect(args).toContain(join(home, ".codex/sessions") + "/");
    expect(JSON.stringify(run.mock.calls)).not.toContain("auth.json");
    expect((run.mock.calls.at(-1)![1] as string[]).at(-1)).toContain(
      "scripts/ai-usage/refresh.ts",
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
it("drains a cancelled previous account sync before loading the new account", async () => {
  vi.useFakeTimers();
  let owner = "owner",
    generation = 1;
  let finish!: () => void;
  const transfer = vi.fn(async () => {
    if (transfer.mock.calls.length === 1)
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
  });
  const service = createUsageSyncService({
    home: "/mac",
    pairingFile: "/private/config",
    auth: {
      getStatus: () => ({
        signedIn: true,
        userId: owner,
        runtimeSlot: "primary",
        authGeneration: generation,
      }),
      getGatewayOrigin: () => pairing.gatewayOrigin,
    },
    readPairing: async () => ({ ...pairing, ownerId: owner }),
    transfer,
  });
  await vi.advanceTimersByTimeAsync(0);
  owner = "new-owner";
  generation = 2;
  service.cancel();
  const next = service.sync({ runtimeSlot: "primary", authGeneration: 2 });
  finish();
  await expect(next).resolves.toMatchObject({ status: "synced" });
  expect(transfer).toHaveBeenCalledTimes(2);
  await service.dispose();
});
