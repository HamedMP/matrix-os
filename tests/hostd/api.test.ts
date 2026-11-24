import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHostApi, type HostApiDeps } from "../../packages/hostd/src/api.js";
import { ChError, type ChClient } from "../../packages/hostd/src/ch-client.js";
import type { Exec } from "../../packages/hostd/src/exec.js";
import { createVmLifecycle, LifecycleError, type VmLifecycle } from "../../packages/hostd/src/vm-lifecycle.js";
import { createVmStore, type VmRecord, type VmStore } from "../../packages/hostd/src/vm-store.js";

const TOKEN = "api-token-0123456789abcdef0123456789abcdef";
const auth = { authorization: `Bearer ${TOKEN}` };

let root: string;
let store: VmStore;
let lifecycle: VmLifecycle;
let gate: Promise<void> | null;
let logs: Array<{ event: string; fields: Record<string, unknown> }>;

const exec: Exec = async (argv) => {
  if (argv[0] === "lvcreate" && gate) await gate;
  if (argv[0] === "lvs" && argv.includes("data_percent,metadata_percent")) return { code: 0, stdout: "  10.00  5.00\n", stderr: "" };
  if (argv[0] === "lvs" && argv.includes("lv_size")) return { code: 0, stdout: "  21474836480\n", stderr: "" };
  // lvs of a VM disk: exit 5 with LVM's "no such LV" message.
  if (argv[0] === "lvs") return { code: 5, stdout: "", stderr: '  Failed to find logical volume "vmvg/mx-x"\n' };
  return { code: 0, stdout: "", stderr: "" };
};

let powered = true;

function ch(): ChClient {
  const ok = async () => undefined;
  return {
    info: async () => ({ state: powered ? "Running" : "Shutdown", memoryActualBytes: 2048 * 1024 * 1024 }),
    pause: ok,
    resume: ok,
    async snapshot(dir) {
      await writeFile(join(dir, "memory-ranges"), "mem");
    },
    resizeMemory: ok,
    async powerButton() {
      powered = false;
    },
    shutdownVmm: ok,
    close: ok,
  };
}

const body = {
  machineId: "machine-1",
  generation: 2,
  handle: "alice",
  tier: "free",
  bootMiB: 2048,
  maxMiB: 8192,
  diskGiB: 20,
  userData: "#cloud-config\n",
  goldenVersion: "2026.11.20-1",
};

function api(overrides: Partial<HostApiDeps> = {}) {
  return createHostApi({
    lifecycle,
    store,
    pool: { freeBytes: async () => 5 * 1024 ** 3 },
    hostAvailableMiB: async () => 100_000,
    apiToken: TOKEN,
    log: (event, fields) => logs.push({ event, fields }),
    ...overrides,
  });
}

function send(app: ReturnType<typeof api>, method: string, path: string, init: { body?: unknown; headers?: Record<string, string> } = {}) {
  const raw = typeof init.body === "string" ? init.body : init.body === undefined ? undefined : JSON.stringify(init.body);
  return app.request(path, {
    method,
    headers: { ...(raw === undefined ? {} : { "content-type": "application/json" }), ...init.headers },
    body: raw,
  });
}

function record(overrides: Partial<VmRecord> = {}): VmRecord {
  return {
    id: "vm_0123456789abcdef01234567",
    machineId: "machine-9",
    generation: 1,
    handle: "zed",
    tier: "free",
    state: "suspended",
    privateIPv4: "10.78.0.50",
    mac: "52:54:00:78:00:32",
    bootMiB: 2048,
    maxMiB: 8192,
    diskGiB: 20,
    chVersion: "v54.1",
    snapshot: { dir: join(root, "snapshots", "vm_0123456789abcdef01234567"), takenAt: "2026-11-21T00:00:00.000Z", chVersion: "v54.1" },
    updatedAt: "2026-11-21T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hostd-api-"));
  await mkdir(join(root, "snapshots"));
  store = createVmStore(join(root, "vms"));
  gate = null;
  powered = true;
  logs = [];
  lifecycle = createVmLifecycle({
    store,
    exec,
    ch: () => ch(),
    pool: { freeBytes: async () => 1024 ** 4 },
    gatewayHealth: async () => true,
    trim: async () => undefined,
    clock: { now: () => Date.now(), sleep: async () => undefined },
    log: () => undefined,
    config: {
      vmsDir: join(root, "vms"),
      snapshotsDir: join(root, "snapshots"),
      serialLogDir: join(root, "log"),
      runDir: join(root, "run"),
      trimSettleMs: 0,
    },
  });
});

afterEach(async () => {
  await lifecycle.idle();
  await rm(root, { recursive: true, force: true });
});

describe("hostd API", () => {
  it("rejects a missing or wrong bearer with 401 before parsing the body", async () => {
    const create = vi.spyOn(lifecycle, "create");
    const app = api({ lifecycle });
    const missing = await send(app, "POST", "/v1/vms", { body: "{not json" });
    const wrong = await send(app, "POST", "/v1/vms", {
      body: "x".repeat(200 * 1024),
      headers: { authorization: `Bearer ${TOKEN}x` },
    });
    const scheme = await send(app, "GET", "/v1/vms", { headers: { authorization: TOKEN } });
    for (const res of [missing, wrong, scheme]) {
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized" });
    }
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects a body over 64 KiB with 413", async () => {
    const app = api();
    const big = { ...body, userData: "x".repeat(64 * 1024 + 1) };
    const res = await send(app, "POST", "/v1/vms", { body: big, headers: auth });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "bad_request" });
    const del = await send(app, "DELETE", `/v1/vms/${record().id}`, { body: "x".repeat(65 * 1024), headers: auth });
    expect(del.status).toBe(413);
    expect(await store.list()).toEqual([]);
  });

  it("create is idempotent for the same machineId and generation", async () => {
    const app = api();
    const first = await send(app, "POST", "/v1/vms", { body, headers: auth });
    expect(first.status).toBe(201);
    const created = (await first.json()) as { id: string; privateIPv4: string };
    expect(created).toEqual({ id: expect.stringMatching(/^vm_[0-9a-f]{24}$/), privateIPv4: "10.78.0.10" });
    const again = await send(app, "POST", "/v1/vms", { body, headers: auth });
    expect(again.status).toBe(201);
    expect(await again.json()).toEqual(created);
    expect(await store.list()).toHaveLength(1);
  });

  it("a create still in progress answers 202 with state creating", async () => {
    let release!: () => void;
    gate = new Promise((r) => {
      release = r;
    });
    const app = api();
    const first = send(app, "POST", "/v1/vms", { body, headers: auth });
    await new Promise((r) => setTimeout(r, 20));
    const second = await send(app, "POST", "/v1/vms", { body, headers: auth });
    expect(second.status).toBe(202);
    const progress = (await second.json()) as { id: string };
    expect(progress).toEqual({ id: expect.any(String), privateIPv4: "10.78.0.10", state: "creating" });
    release();
    const done = await first;
    expect(done.status).toBe(201);
    expect(await done.json()).toEqual({ id: progress.id, privateIPv4: "10.78.0.10" });
  });

  it("create with an older generation returns 409 conflict", async () => {
    const app = api();
    expect((await send(app, "POST", "/v1/vms", { body, headers: auth })).status).toBe(201);
    const older = await send(app, "POST", "/v1/vms", { body: { ...body, generation: 1 }, headers: auth });
    expect(older.status).toBe(409);
    expect(await older.json()).toEqual({ error: "conflict" });
  });

  it("create rejects an invalid body with bad_request and no validation details", async () => {
    const app = api();
    for (const bad of [{ ...body, tier: "gold" }, { ...body, extra: 1 }, "{oops", { ...body, handle: "../x" }]) {
      const res = await send(app, "POST", "/v1/vms", { body: bad, headers: auth });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "bad_request" });
    }
  });

  it("create answers 409 for a VM that failed after it was created, keeping its disk", async () => {
    await store.put(record({ machineId: "machine-1", generation: 2, handle: "alice", state: "failed" }));
    const res = await send(api(), "POST", "/v1/vms", { body, headers: auth });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "conflict" });
    await expect(store.get(record().id)).resolves.toMatchObject({ state: "failed" });
  });

  it("enforces free-tier limits with bad_request", async () => {
    const app = api();
    for (const patch of [{ bootMiB: 4096 }, { maxMiB: 16384 }, { diskGiB: 41 }]) {
      const res = await send(app, "POST", "/v1/vms", { body: { ...body, ...patch }, headers: auth });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "bad_request" });
    }
    const createdRes = await send(app, "POST", "/v1/vms", { body: { ...body, diskGiB: 40 }, headers: auth });
    expect(createdRes.status).toBeLessThan(300);
    const created = (await createdRes.json()) as { id: string };
    const shown = (await (await send(app, "GET", `/v1/vms/${created.id}`, { headers: auth })).json()) as { diskGiB: number };
    expect(shown.diskGiB).toBe(40);
    const raise = await send(app, "PUT", `/v1/vms/${created.id}/policy`, { body: { tier: "free", maxMiB: 16384 }, headers: auth });
    expect(raise.status).toBe(400);
    const huge = await send(app, "PUT", `/v1/vms/${created.id}/policy`, { body: { tier: "paid", maxMiB: 262144 }, headers: auth });
    expect(huge.status).toBe(400);
  });

  it("resume clamps budgetMs to 15000", async () => {
    await store.put(record());
    const resume = vi.fn(async () => "starting" as const);
    const app = api({ lifecycle: { ...lifecycle, resume } });
    const res = await send(app, "POST", `/v1/vms/${record().id}/resume`, { body: { budgetMs: 60_000 }, headers: auth });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ state: "starting" });
    expect(resume).toHaveBeenCalledWith(record().id, 15_000);
    const bad = await send(app, "POST", `/v1/vms/${record().id}/resume`, { body: { budgetMs: -1 }, headers: auth });
    expect(bad.status).toBe(400);
  });

  it("resume runs the real restore and reports running", async () => {
    await store.put(record());
    await mkdir(join(root, "vms", record().id), { recursive: true });
    const res = await send(api(), "POST", `/v1/vms/${record().id}/resume`, { body: { budgetMs: 1000 }, headers: auth });
    expect(await res.json()).toEqual({ state: "running" });
  });

  it("GET /v1/vms/:id never includes filesystem paths", async () => {
    await store.put(record());
    const app = api();
    const one = await send(app, "GET", `/v1/vms/${record().id}`, { headers: auth });
    const all = await send(app, "GET", "/v1/vms", { headers: auth });
    const oneText = await one.text();
    const allText = await all.text();
    for (const text of [oneText, allText]) {
      expect(text).not.toContain(root);
      expect(text).not.toContain("/");
      expect(text).not.toContain('"dir"');
    }
    expect(JSON.parse(oneText)).toMatchObject({
      id: record().id,
      state: "suspended",
      snapshot: { takenAt: "2026-11-21T00:00:00.000Z", chVersion: "v54.1" },
    });
    expect(JSON.parse(allText)).toEqual({ vms: [JSON.parse(oneText)] });
    const missing = await send(app, "GET", "/v1/vms/vm_ffffffffffffffffffffffff", { headers: auth });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "not_found" });
    const badId = await send(app, "GET", "/v1/vms/..%2Fetc", { headers: auth });
    expect(badId.status).toBe(400);
  });

  it("an internal error returns { error: internal } without the message", async () => {
    await store.put(record());
    const secret = "cloud-hypervisor at /run/matrix-vm/x/ch.sock refused 10.78.0.50";
    for (const error of [new Error(secret), new ChError("rejected", secret), new LifecycleError("snapshot_failed", secret)]) {
      const app = api({ lifecycle: { ...lifecycle, stop: async () => Promise.reject(error) } });
      const res = await send(app, "POST", `/v1/vms/${record().id}/stop`, { headers: auth });
      expect(res.status).toBe(500);
      const text = await res.text();
      expect(JSON.parse(text)).toEqual({ error: "internal" });
      expect(text).not.toContain("refused");
    }
    expect(logs.some((l) => l.event === "api.request_failed")).toBe(true);
  });

  it("maps lifecycle codes onto the API error set", async () => {
    await store.put(record());
    const cases: Array<[LifecycleError["code"], number, string]> = [
      ["pool_full", 507, "pool_full"],
      ["no_capacity", 503, "busy"],
      ["capacity", 503, "capacity"],
      ["busy", 503, "busy"],
      ["conflict", 409, "conflict"],
      ["not_found", 404, "not_found"],
      ["invalid", 400, "bad_request"],
      ["failed", 500, "internal"],
    ];
    for (const [code, status, error] of cases) {
      const app = api({ lifecycle: { ...lifecycle, stop: async () => Promise.reject(new LifecycleError(code, "x")) } });
      const res = await send(app, "POST", `/v1/vms/${record().id}/stop`, { headers: auth });
      expect([code, res.status, await res.json()]).toEqual([code, status, { error }]);
    }
  });

  it("suspend answers 202 and GET then shows the state", async () => {
    const app = api();
    const created = (await (await send(app, "POST", "/v1/vms", { body, headers: auth })).json()) as { id: string };
    const res = await send(app, "POST", `/v1/vms/${created.id}/suspend`, { headers: auth });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ state: "suspending" });
    await lifecycle.idle();
    const after = await send(app, "GET", `/v1/vms/${created.id}`, { headers: auth });
    expect(await after.json()).toMatchObject({ state: "suspended" });
    const missing = await send(app, "POST", "/v1/vms/vm_ffffffffffffffffffffffff/suspend", { headers: auth });
    expect(missing.status).toBe(404);
  });

  it("a background suspend failure is logged and leaves the record as the lifecycle left it", async () => {
    await store.put(record({ state: "running", snapshot: null }));
    const suspend = vi.fn(async () => Promise.reject(new LifecycleError("pool_full", "full")));
    const res = await send(api({ lifecycle: { ...lifecycle, suspend } }), "POST", `/v1/vms/${record().id}/suspend`, {
      headers: auth,
    });
    expect(res.status).toBe(202);
    await new Promise((r) => setTimeout(r, 0));
    expect(logs).toContainEqual({ event: "api.suspend_failed", fields: { id: record().id, code: "pool_full" } });
  });

  it("resume with a mismatched expectedGeneration returns 409 and does not resume", async () => {
    await store.put(record());
    await mkdir(join(root, "vms", record().id), { recursive: true });
    const res = await send(api(), "POST", `/v1/vms/${record().id}/resume`, {
      body: { budgetMs: 1000, expectedGeneration: 2 },
      headers: auth,
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "conflict" });
    await expect(store.get(record().id)).resolves.toMatchObject({ state: "suspended", generation: 1 });
  });

  it("suspend with a mismatched expectedGeneration returns 409 and does not suspend", async () => {
    const app = api();
    const created = (await (await send(app, "POST", "/v1/vms", { body, headers: auth })).json()) as { id: string };
    const res = await send(app, "POST", `/v1/vms/${created.id}/suspend`, { body: { expectedGeneration: 3 }, headers: auth });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "conflict" });
    await lifecycle.idle();
    await expect(store.get(created.id)).resolves.toMatchObject({ state: "running", snapshot: null });
    expect(logs.map((l) => l.event)).not.toContain("api.suspend_failed");
  });

  it("resume/suspend without expectedGeneration behave as before", async () => {
    const app = api();
    const created = (await (await send(app, "POST", "/v1/vms", { body, headers: auth })).json()) as { id: string };
    const suspended = await send(app, "POST", `/v1/vms/${created.id}/suspend`, { headers: auth });
    expect(suspended.status).toBe(202);
    await lifecycle.idle();
    await expect(store.get(created.id)).resolves.toMatchObject({ state: "suspended" });
    const resumed = await send(app, "POST", `/v1/vms/${created.id}/resume`, { body: { budgetMs: 1000 }, headers: auth });
    expect(await resumed.json()).toEqual({ state: "running" });
    const emptyObject = await send(app, "POST", `/v1/vms/${created.id}/suspend`, { body: {}, headers: auth });
    expect(emptyObject.status).toBe(202);
    await lifecycle.idle();
    await expect(store.get(created.id)).resolves.toMatchObject({ state: "suspended" });
  });

  it("accepts generation 0 as an expectedGeneration for a VM created at generation 0", async () => {
    const app = api();
    const created = (await (await send(app, "POST", "/v1/vms", { body: { ...body, generation: 0 }, headers: auth })).json()) as {
      id: string;
    };
    await expect(store.get(created.id)).resolves.toMatchObject({ generation: 0 });
    const suspended = await send(app, "POST", `/v1/vms/${created.id}/suspend`, { body: { expectedGeneration: 0 }, headers: auth });
    expect(suspended.status).toBe(202);
    await lifecycle.idle();
    await expect(store.get(created.id)).resolves.toMatchObject({ state: "suspended" });
    const resumed = await send(app, "POST", `/v1/vms/${created.id}/resume`, {
      body: { budgetMs: 1000, expectedGeneration: 0 },
      headers: auth,
    });
    expect(await resumed.json()).toEqual({ state: "running" });
    const negative = await send(app, "POST", `/v1/vms/${created.id}/suspend`, { body: { expectedGeneration: -1 }, headers: auth });
    expect(negative.status).toBe(400);
  });

  it("resume and suspend with a matching expectedGeneration act on the VM", async () => {
    const app = api();
    const created = (await (await send(app, "POST", "/v1/vms", { body, headers: auth })).json()) as { id: string };
    const suspended = await send(app, "POST", `/v1/vms/${created.id}/suspend`, { body: { expectedGeneration: 2 }, headers: auth });
    expect(suspended.status).toBe(202);
    expect(await suspended.json()).toEqual({ state: "suspending" });
    await lifecycle.idle();
    await expect(store.get(created.id)).resolves.toMatchObject({ state: "suspended" });
    const resumed = await send(app, "POST", `/v1/vms/${created.id}/resume`, {
      body: { budgetMs: 1000, expectedGeneration: 2 },
      headers: auth,
    });
    expect(await resumed.json()).toEqual({ state: "running" });
  });

  it("rejects an invalid expectedGeneration or suspend body with 400", async () => {
    await store.put(record());
    const app = api();
    const path = `/v1/vms/${record().id}`;
    for (const expectedGeneration of [-1, 1.5, "1"]) {
      const resume = await send(app, "POST", `${path}/resume`, { body: { budgetMs: 1, expectedGeneration }, headers: auth });
      expect(resume.status).toBe(400);
      const suspend = await send(app, "POST", `${path}/suspend`, { body: { expectedGeneration }, headers: auth });
      expect(suspend.status).toBe(400);
    }
    expect((await send(app, "POST", `${path}/suspend`, { body: "{nope", headers: auth })).status).toBe(400);
    expect((await send(app, "POST", `${path}/suspend`, { body: { other: 1 }, headers: auth })).status).toBe(400);
    expect((await send(app, "POST", `${path}/suspend`, { body: "x".repeat(70_000), headers: auth })).status).toBe(413);
  });

  it("a suspend failure after the generation check is logged and still answers 202", async () => {
    await store.put(record({ state: "running", snapshot: null }));
    const suspend = vi.fn(async (_id: string, options?: { onAccepted?: () => void }) => {
      options?.onAccepted?.();
      throw new LifecycleError("pool_full", "full");
    });
    const res = await send(api({ lifecycle: { ...lifecycle, suspend } }), "POST", `/v1/vms/${record().id}/suspend`, {
      body: { expectedGeneration: 1 },
      headers: auth,
    });
    expect(res.status).toBe(202);
    await new Promise((r) => setTimeout(r, 0));
    expect(logs).toContainEqual({ event: "api.suspend_failed", fields: { id: record().id, code: "pool_full" } });
  });

  it("stop, policy and delete act on the VM", async () => {
    const app = api();
    const created = (await (await send(app, "POST", "/v1/vms", { body, headers: auth })).json()) as { id: string };
    const policy = await send(app, "PUT", `/v1/vms/${created.id}/policy`, { body: { tier: "paid", maxMiB: 16384 }, headers: auth });
    expect(policy.status).toBe(200);
    expect(await policy.json()).toMatchObject({ tier: "paid", maxMiB: 16384 });
    const badPolicy = await send(app, "PUT", `/v1/vms/${created.id}/policy`, { body: { tier: "paid" }, headers: auth });
    expect(badPolicy.status).toBe(400);
    const stopped = await send(app, "POST", `/v1/vms/${created.id}/stop`, { headers: auth });
    expect(await stopped.json()).toEqual({ state: "stopped" });
    const deleted = await send(app, "DELETE", `/v1/vms/${created.id}`, { headers: auth });
    expect(deleted.status).toBe(204);
    await expect(store.get(created.id)).resolves.toBeNull();
  });

  it("GET /v1/capacity reports memory, pool and VM counts", async () => {
    await store.put(record());
    await store.put(record({ id: "vm_bbbbbbbbbbbbbbbbbbbbbbbb", machineId: "m2", handle: "bob", state: "running" }));
    const res = await send(api(), "GET", "/v1/capacity", { headers: auth });
    expect(await res.json()).toEqual({
      memoryAvailableMiB: 100_000,
      poolFreeBytes: 5 * 1024 ** 3,
      thinPool: { dataPercent: 10, metadataPercent: 5 },
      runningVms: 1,
      suspendedVms: 1,
    });
  });

  it("GET /v1/capacity answers thinPool null quickly when the pool read hangs", async () => {
    let seenSignal: AbortSignal | undefined;
    const app = api({
      capacityTimeoutMs: 50,
      lifecycle: {
        ...lifecycle,
        thinPoolUsage: (signal?: AbortSignal) => {
          seenSignal = signal;
          return new Promise(() => undefined);
        },
      },
    });
    const started = Date.now();
    const res = await send(app, "GET", "/v1/capacity", { headers: auth });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ thinPool: null, memoryAvailableMiB: 100_000 });
    expect(seenSignal?.aborted).toBe(true);
  });

  it("GET /v1/capacity reports thinPool null when the pool usage is unreadable", async () => {
    const app = api({ lifecycle: { ...lifecycle, thinPoolUsage: async () => Promise.reject(new LifecycleError("capacity", "x")) } });
    const res = await send(app, "GET", "/v1/capacity", { headers: auth });
    expect(res.status).toBe(200);
    expect((await res.json()).thinPool).toBeNull();
  });

  it("an unknown route answers not_found", async () => {
    const res = await send(api(), "GET", "/v1/nope", { headers: auth });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("refuses to build with a short token", () => {
    expect(() => api({ apiToken: "short" })).toThrow();
  });
});
