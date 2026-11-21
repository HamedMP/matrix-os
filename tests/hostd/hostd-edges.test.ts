import { chmod, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHostApi, toApiErrorCode } from "../../packages/hostd/src/api.js";
import { ChError, createChClient, type ChClient } from "../../packages/hostd/src/ch-client.js";
import { createExec, ExecError } from "../../packages/hostd/src/exec.js";
import { createGuestClient } from "../../packages/hostd/src/guest-client.js";
import { createMemoryController, readHostAvailableMiB, type MemoryControllerDeps } from "../../packages/hostd/src/memory-controller.js";
import { reconcileVms } from "../../packages/hostd/src/reconcile.js";
import { LifecycleError, type VmLifecycle } from "../../packages/hostd/src/vm-lifecycle.js";
import { createVmStore, parseVmRecord, writeFileAtomic, type VmRecord, type VmStore } from "../../packages/hostd/src/vm-store.js";

// Error and default paths across the smaller hostd modules.

const ID = "vm_0123456789abcdef01234567";
let dir: string;
const servers: Server[] = [];

function record(overrides: Partial<VmRecord> = {}): VmRecord {
  return {
    id: ID,
    machineId: "machine-1",
    generation: 1,
    handle: "alice",
    tier: "free",
    state: "running",
    privateIPv4: "10.78.0.10",
    mac: "52:54:00:78:00:0a",
    bootMiB: 2048,
    maxMiB: 8192,
    diskGiB: 20,
    chVersion: "v54.1",
    snapshot: null,
    updatedAt: "2026-11-21T00:00:00.000Z",
    ...overrides,
  };
}

async function listenUnix(server: Server, path: string): Promise<void> {
  await new Promise<void>((resolve) => server.listen(path, resolve));
  servers.push(server);
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hostd-edges-"));
});

afterEach(async () => {
  for (const server of servers.splice(0)) {
    (server as { closeAllConnections?: () => void }).closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
  vi.restoreAllMocks();
  await chmod(join(dir, "vms", ID), 0o700).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
  await rm(dir, { recursive: true, force: true });
});

const signal = () => AbortSignal.timeout(2_000);

describe("VM store edges", () => {
  it("rejects records that are not objects or carry an invalid snapshot", () => {
    expect(() => parseVmRecord(null)).toThrow("invalid VM record");
    expect(() => parseVmRecord({ ...record(), snapshot: "x" })).toThrow("invalid VM record");
  });

  it("removes the temp file when an atomic write fails", async () => {
    await expect(writeFileAtomic(join(dir, "missing", "f.json"), "{}")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects oversized and corrupt records, and rethrows non-syntax parse failures", async () => {
    const store = createVmStore(join(dir, "vms"));
    await mkdir(join(dir, "vms", ID), { recursive: true });
    await writeFile(join(dir, "vms", ID, "record.json"), "x".repeat(64 * 1024 + 1));
    await expect(store.get(ID)).rejects.toThrow("too large");
    await writeFile(join(dir, "vms", ID, "record.json"), "{oops");
    await expect(store.get(ID)).rejects.toThrow("corrupt VM record");
    vi.spyOn(JSON, "parse").mockImplementationOnce(() => {
      throw new RangeError("stack");
    });
    await expect(store.get(ID)).rejects.toBeInstanceOf(RangeError);
  });

  it("list skips foreign names and files, sweeps stale temps, and surfaces unexpected errors", async () => {
    const root = join(dir, "vms");
    const store = createVmStore(root);
    await store.put(record());
    await mkdir(join(root, "not-a-vm"));
    await writeFile(join(root, "vm_ffffffffffffffffffffffff"), "a file");
    const old = join(root, ID, "record.json.0011.tmp");
    await writeFile(old, "x");
    await utimes(old, new Date(0), new Date(0));
    await writeFile(join(root, ID, "fresh.tmp"), "x");
    await mkdir(join(root, ID, "dir.tmp"));
    expect((await store.list()).map((r) => r.id)).toEqual([ID]);

    const locked = join(root, ID, "locked.tmp");
    await writeFile(locked, "x");
    await utimes(locked, new Date(0), new Date(0));
    await chmod(join(root, ID), 0o500);
    await expect(store.list()).rejects.toMatchObject({ code: "EACCES" });
    await chmod(join(root, ID), 0o700);

    await writeFile(join(dir, "file-root"), "x");
    await expect(createVmStore(join(dir, "file-root")).list()).rejects.toMatchObject({ code: "ENOTDIR" });
  });

  it("isolates throwing change listeners, logging through the default logger", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const store = createVmStore(join(dir, "vms"));
    store.onChange(() => {
      throw new Error("listener broke");
    });
    store.onChange(() => {
      throw "plain";
    });
    await store.put(record());
    expect(error.mock.calls.filter((c) => String(c[0]).includes("vm_store.listener_failed"))).toHaveLength(2);
  });
});

describe("Cloud Hypervisor client edges", () => {
  async function serve(handler: Parameters<typeof createHttpServer>[0] extends infer _ ? (res: import("node:http").ServerResponse) => void : never) {
    const path = join(dir, "ch.sock");
    await listenUnix(createHttpServer((_req, res) => handler(res)), path);
    return createChClient(path);
  }

  it("rejects oversized, non-JSON, null, and invalid-memory VM info", async () => {
    let body = "";
    const client = await serve((res) => res.end(body));
    try {
      for (const text of ["x".repeat(1024 * 1024 + 1), "{oops", "null", '{"state":"Running","memory_actual_size":-1}']) {
        body = text;
        await expect(client.info(signal())).rejects.toMatchObject({ name: "ChError", code: "rejected" });
      }
      body = '{"state":"Running","memory_actual_size":1}';
      vi.spyOn(JSON, "parse").mockImplementationOnce(() => {
        throw new RangeError("stack");
      });
      await expect(client.info(signal())).rejects.toBeInstanceOf(RangeError);
    } finally {
      await client.close();
    }
  });

  it("maps a protocol error to rejected", async () => {
    const path = join(dir, "ch.sock");
    const sockets: Socket[] = [];
    await listenUnix(
      createNetServer((socket: Socket) => {
        sockets.push(socket);
        socket.end("garbage that is not HTTP\r\n\r\n");
      }),
      path,
    );
    const client = createChClient(path);
    try {
      await expect(client.pause(signal())).rejects.toMatchObject({ code: "rejected" });
    } finally {
      for (const socket of sockets) socket.destroy();
      await client.close();
    }
  });
});

describe("guest client edges", () => {
  async function guest(reply: (socket: Socket) => void) {
    const path = join(dir, "vsock.sock");
    await listenUnix(
      createNetServer((socket) => {
        let stage = 0;
        socket.on("data", () => {
          stage += 1;
          if (stage === 1) socket.write("OK 1\n");
          else reply(socket);
        });
      }),
      path,
    );
    return createGuestClient(path);
  }

  it("refuses an already-aborted signal", async () => {
    const client = createGuestClient(join(dir, "none.sock"));
    await expect(client.stats(AbortSignal.abort())).rejects.toMatchObject({ code: "timeout" });
  });

  it("rejects oversized, non-JSON, invalid stats and a failed trim", async () => {
    let answer = "";
    const client = await guest((socket) => socket.write(answer));
    for (const text of ["x".repeat(9000), "{oops\n", '{"psiSome10":-1}\n', "null\n"]) {
      answer = text;
      await expect(client.stats(signal())).rejects.toMatchObject({ code: "rejected" });
    }
    answer = '{"ok":false}\n';
    await expect(client.trim(signal())).rejects.toMatchObject({ code: "rejected" });
  });

  it("maps an unexpected socket error to rejected", async () => {
    await mkdir(join(dir, "a-dir.sock"));
    await writeFile(join(dir, "plain-file.sock"), "x");
    const codes = await Promise.all(
      ["a-dir.sock", "plain-file.sock"].map((name) =>
        createGuestClient(join(dir, name)).stats(signal()).then(
          () => "ok",
          (error: { code: string }) => error.code,
        ),
      ),
    );
    expect(codes.every((code) => code === "rejected" || code === "unreachable")).toBe(true);
  });
});

describe("memory controller edges", () => {
  function deps(overrides: Partial<MemoryControllerDeps> = {}): MemoryControllerDeps {
    const ch: ChClient = {
      info: async () => ({ state: "Running", memoryActualBytes: 2048 * 1024 * 1024 }),
      pause: async () => undefined,
      resume: async () => undefined,
      snapshot: async () => undefined,
      resizeMemory: async () => undefined,
      powerButton: async () => undefined,
      shutdownVmm: async () => undefined,
      close: async () => undefined,
    };
    return {
      store: { list: async () => [record()], get: async () => record() },
      ch: () => ch,
      guest: () => ({ stats: async () => ({ psiSome10: 0, availableMiB: 1000, anonMiB: 100 }) }),
      resize: async () => undefined,
      ...overrides,
    };
  }

  it("reads MemAvailable and rejects meminfo without it", async () => {
    const path = join(dir, "meminfo");
    await writeFile(path, "MemTotal: 1 kB\n");
    await expect(readHostAvailableMiB(signal(), path)).rejects.toBeInstanceOf(RangeError);
    await writeFile(path, "MemAvailable:    2097152 kB\n");
    await expect(readHostAvailableMiB(signal(), path)).resolves.toBe(2048);
  });

  it("uses the real host reader and default logger, and logs idle, close, list, and non-Error failures", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const closing: ChClient = {
      ...deps().ch(ID),
      close: async () => Promise.reject(new Error("close failed")),
    };
    await createMemoryController(
      deps({
        ch: () => closing,
        idleSeconds: () => {
          throw new Error("idle broke");
        },
        guest: () => ({ stats: () => Promise.reject("plain") }),
      }),
    ).tick();
    await createMemoryController(deps({ store: { list: async () => Promise.reject(new Error("EIO")), get: async () => null } })).tick();
    const events = error.mock.calls.map((c) => JSON.parse(String(c[0])).event as string);
    expect(events).toEqual(expect.arrayContaining(["memory.sample_failed", "memory.ch_close_failed", "memory.list_failed"]));

    const idle = await createMemoryController(
      deps({
        idleSeconds: () => {
          throw new Error("idle broke");
        },
        log: () => undefined,
      }),
    );
    await expect(idle.tick()).resolves.toBeUndefined();
    const logs: string[] = [];
    await createMemoryController(
      deps({ idleSeconds: () => Promise.reject(new Error("idle broke")), log: (event) => logs.push(event) }),
    ).tick();
    expect(logs).toContain("memory.idle_read_failed");
  });

  it("start is idempotent and does nothing after stop", async () => {
    let lists = 0;
    const controller = createMemoryController(
      deps({
        store: {
          list: async () => {
            lists += 1;
            return [];
          },
          get: async () => null,
        },
        intervalMs: 60_000,
        log: () => undefined,
      }),
    );
    controller.start();
    controller.start();
    await controller.stop();
    controller.start();
    expect(lists).toBe(1);
  });
});

describe("reconcile, API and exec edges", () => {
  it("reconcile logs a non-Error systemd failure through the default logger and fails a VM whose snapshot path is not a directory", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const store = createVmStore(join(dir, "vms"));
    await store.put(record({ state: "creating" }));
    await reconcileVms({ store, exec: () => Promise.reject("plain"), ch: () => undefined as never, snapshotsDir: dir });
    await expect(store.get(ID)).resolves.toMatchObject({ state: "failed" });
    expect(error.mock.calls.some((c) => String(c[0]).includes('"error":"plain"'))).toBe(true);

    await store.put(record({ state: "suspending" }));
    await writeFile(join(dir, "snapshots-file"), "x");
    const logs: string[] = [];
    await reconcileVms({
      store,
      exec: async () => ({ code: 3, stdout: "", stderr: "" }),
      ch: () => undefined as never,
      snapshotsDir: join(dir, "snapshots-file"),
      log: (event) => logs.push(event),
    });
    await expect(store.get(ID)).resolves.toMatchObject({ state: "failed" });
    expect(logs).toContain("reconcile.query_failed");
  });

  it("API maps unknown codes and non-lifecycle failures to internal, logs with the default logger, and fails a broken body stream", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(toApiErrorCode(new LifecycleError("mystery" as LifecycleError["code"], "x"))).toBe("internal");
    const store = createVmStore(join(dir, "vms"));
    await store.put(record());
    const lifecycle = {
      stop: () => Promise.reject(new ChError("rejected", "x")),
      suspend: () => Promise.reject(new ChError("timeout", "x")),
      resume: async () => "running" as const,
    } as unknown as VmLifecycle;
    const app = createHostApi({
      lifecycle,
      store,
      pool: { freeBytes: async () => 0 },
      hostAvailableMiB: async () => 0,
      apiToken: "t".repeat(32),
    });
    const auth = { authorization: `Bearer ${"t".repeat(32)}` };
    const stopped = await app.request(`/v1/vms/${ID}/stop`, { method: "POST", headers: auth });
    expect(stopped.status).toBe(500);
    expect(error.mock.calls.some((c) => String(c[0]).includes("api.request_failed"))).toBe(true);
    expect((await app.request(`/v1/vms/${ID}/suspend`, { method: "POST", headers: auth })).status).toBe(202);
    await new Promise((r) => setTimeout(r, 0));
    expect(error.mock.calls.some((c) => String(c[0]).includes('"code":"internal"'))).toBe(true);

    const broken = new ReadableStream({
      pull(controller) {
        controller.error(new TypeError("stream broke"));
      },
    });
    const res = await app.request(
      new Request(`http://hostd/v1/vms/${ID}/resume`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json", "content-length": "10" },
        body: broken,
        duplex: "half",
      } as RequestInit),
    );
    expect(res.status).toBe(500);
  });

  it("exec reports a signal exit, and an ExecError without an exit code names the signal", async () => {
    await expect(createExec()(["sh", "-c", "kill -9 $$"], { signal: signal() })).resolves.toMatchObject({ code: -1 });
    expect(new ExecError("failed", "lvcreate").message).toBe("lvcreate exited with a signal");
    const result = await createExec()(["sh", "-c", "printf x; head -c 300000 /dev/zero"], { signal: signal() });
    expect(result.stdout.length).toBe(256 * 1024);
  });
});
