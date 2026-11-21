import { createHash, timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod/v4";
import { LifecycleError, type VmLifecycle } from "./vm-lifecycle.js";
import { VM_ID_PATTERN, type VmRecord, type VmStore } from "./vm-store.js";

// The authenticated host API the platform calls (TLS port 8443). Every route
// checks the bearer before anything else, mutating routes cap the body at
// 64 KiB, and every input is validated with Zod. Clients only ever see the
// typed error codes below: never messages, paths, provider names or IPs.

export type ApiErrorCode = "unauthorized" | "bad_request" | "not_found" | "busy" | "pool_full" | "conflict" | "internal";

type ApiStatus = 400 | 401 | 404 | 409 | 413 | 500 | 503 | 507;

export const MAX_BODY_BYTES = 64 * 1024;
export const MAX_RESUME_BUDGET_MS = 15_000;
const CAPACITY_TIMEOUT_MS = 2_000;

export interface HostApiDeps {
  lifecycle: VmLifecycle;
  store: Pick<VmStore, "get" | "list">;
  pool: { freeBytes(): Promise<number> };
  hostAvailableMiB: (signal: AbortSignal) => Promise<number>;
  apiToken: string;
  log?: (event: string, fields: Record<string, unknown>) => void;
}

class ApiError extends Error {
  constructor(readonly code: ApiErrorCode) {
    super(code);
    this.name = "ApiError";
  }
}

const STATUS: Record<ApiErrorCode, ApiStatus> = {
  unauthorized: 401,
  bad_request: 400,
  not_found: 404,
  conflict: 409,
  busy: 503,
  pool_full: 507,
  internal: 500,
};

const LIFECYCLE_CODES: Record<LifecycleError["code"], ApiErrorCode> = {
  invalid: "bad_request",
  not_found: "not_found",
  conflict: "conflict",
  busy: "busy",
  pool_full: "pool_full",
  no_capacity: "busy",
  snapshot_failed: "internal",
  failed: "internal",
};

export function toApiErrorCode(error: unknown): ApiErrorCode {
  if (error instanceof ApiError) return error.code;
  if (error instanceof LifecycleError) return LIFECYCLE_CODES[error.code] ?? "internal";
  return "internal";
}

const SAFE_MACHINE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SAFE_HANDLE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SAFE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const mib = (max: number) => z.int().min(512).max(max).multipleOf(128);

const CreateVmRequest = z.strictObject({
  machineId: z.string().regex(SAFE_MACHINE_ID),
  generation: z.int().min(0),
  handle: z.string().regex(SAFE_HANDLE),
  tier: z.enum(["free", "paid"]),
  bootMiB: mib(65_536),
  maxMiB: mib(131_072),
  diskGiB: z.int().min(1).max(1024),
  userData: z.string().refine((value) => Buffer.byteLength(value) <= MAX_BODY_BYTES),
  goldenVersion: z.string().regex(SAFE_VERSION),
});

const ResumeRequest = z.strictObject({ budgetMs: z.int().min(0) });
const PolicyRequest = z.strictObject({ tier: z.enum(["free", "paid"]), maxMiB: mib(131_072) });
const VmId = z.string().regex(VM_ID_PATTERN);

// The client view of a record: host paths (the snapshot dir) stay on the host.
export function publicVm(record: VmRecord) {
  return {
    id: record.id,
    machineId: record.machineId,
    generation: record.generation,
    handle: record.handle,
    tier: record.tier,
    state: record.state,
    privateIPv4: record.privateIPv4,
    bootMiB: record.bootMiB,
    maxMiB: record.maxMiB,
    diskGiB: record.diskGiB,
    chVersion: record.chVersion,
    snapshot: record.snapshot === null ? null : { takenAt: record.snapshot.takenAt, chVersion: record.snapshot.chVersion },
    updatedAt: record.updatedAt,
    ...(record.failedDuring === undefined ? {} : { failedDuring: record.failedDuring }),
  };
}

const digest = (value: string) => createHash("sha256").update(value).digest();

// Hono hands onError only Error instances.
const errorFields = (error: Error) => ({ error: error.name, message: error.message, code: (error as { code?: unknown }).code });

function vmId(c: Context): string {
  const parsed = VmId.safeParse(c.req.param("id"));
  if (!parsed.success) throw new ApiError("bad_request");
  return parsed.data;
}

async function readBody<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch (error: unknown) {
    if (error instanceof SyntaxError) throw new ApiError("bad_request");
    throw error;
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new ApiError("bad_request");
  return parsed.data;
}

export function createHostApi(deps: HostApiDeps): Hono {
  if (deps.apiToken.length < 32) throw new Error("API token too short");
  const log = deps.log ?? ((event, fields) => console.error(JSON.stringify({ event, ...fields })));
  const { lifecycle, store } = deps;
  const tokenDigest = digest(deps.apiToken);
  const fail = (c: Context, code: ApiErrorCode) => c.json({ error: code }, STATUS[code]);
  const limit = bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => c.json({ error: "bad_request" }, 413) });

  async function loadVm(id: string): Promise<VmRecord> {
    const record = await store.get(id);
    if (record === null) throw new ApiError("not_found");
    return record;
  }

  const app = new Hono();

  // Authentication runs first on every route, before any body is read.
  app.use("*", async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
    if (token.length === 0 || !timingSafeEqual(digest(token), tokenDigest)) return fail(c, "unauthorized");
    await next();
  });

  app.post("/v1/vms", limit, async (c) => {
    const spec = await readBody(c, CreateVmRequest);
    const record = await lifecycle.create(spec);
    if (record.state === "creating") {
      return c.json({ id: record.id, privateIPv4: record.privateIPv4, state: "creating" as const }, 202);
    }
    return c.json({ id: record.id, privateIPv4: record.privateIPv4 }, 201);
  });

  app.get("/v1/vms", async (c) => c.json({ vms: (await store.list()).map(publicVm) }));

  app.get("/v1/vms/:id", async (c) => c.json(publicVm(await loadVm(vmId(c)))));

  app.post("/v1/vms/:id/resume", limit, async (c) => {
    const id = vmId(c);
    const { budgetMs } = await readBody(c, ResumeRequest);
    const state = await lifecycle.resume(id, Math.min(budgetMs, MAX_RESUME_BUDGET_MS));
    return c.json({ state });
  });

  app.post("/v1/vms/:id/suspend", limit, async (c) => {
    const id = vmId(c);
    await loadVm(id);
    // Snapshotting takes seconds: answer now; the platform reads the outcome
    // with GET. A failed snapshot leaves the VM running, which GET shows.
    lifecycle.suspend(id).catch((error: unknown) => {
      log("api.suspend_failed", { id, code: error instanceof LifecycleError ? error.code : "internal" });
    });
    return c.json({ state: "suspending" as const }, 202);
  });

  app.post("/v1/vms/:id/stop", limit, async (c) => {
    const record = await lifecycle.stop(vmId(c));
    return c.json({ state: record.state });
  });

  app.delete("/v1/vms/:id", limit, async (c) => {
    await lifecycle.destroy(vmId(c));
    return c.body(null, 204);
  });

  app.put("/v1/vms/:id/policy", limit, async (c) => {
    const id = vmId(c);
    const policy = await readBody(c, PolicyRequest);
    return c.json(publicVm(await lifecycle.setPolicy(id, policy)));
  });

  app.get("/v1/capacity", async (c) => {
    const [memoryAvailableMiB, poolFreeBytes, records] = await Promise.all([
      deps.hostAvailableMiB(AbortSignal.timeout(CAPACITY_TIMEOUT_MS)),
      deps.pool.freeBytes(),
      store.list(),
    ]);
    return c.json({
      memoryAvailableMiB,
      poolFreeBytes,
      runningVms: records.filter((r) => r.state === "running").length,
      suspendedVms: records.filter((r) => r.state === "suspended").length,
    });
  });

  app.notFound((c) => fail(c, "not_found"));

  app.onError((error, c) => {
    const code = toApiErrorCode(error);
    if (code === "internal") log("api.request_failed", { method: c.req.method, path: c.req.routePath, ...errorFields(error) });
    return fail(c, code);
  });

  return app;
}
