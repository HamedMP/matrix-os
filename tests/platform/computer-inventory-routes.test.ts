import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "kysely";

import { MatrixComputerListSchema } from "@matrix-os/contracts";
import { createClerkAuth } from "../../packages/platform/src/clerk-auth.js";
import {
  type PlatformDB,
  insertUserMachine,
} from "../../packages/platform/src/db.js";
import { createApp } from "../../packages/platform/src/main.js";
import { issueSyncJwt } from "../../packages/platform/src/sync-jwt.js";
import {
  JWT_SECRET,
  cleanupProxyRoutingTest,
  setupProxyRoutingTest,
  stubOrchestrator,
} from "./proxy-routing-test-utils.js";

async function insertMachine(
  db: PlatformDB,
  input: {
    machineId?: string;
    clerkUserId?: string;
    handle: string;
    runtimeSlot: string;
    status?: string;
    imageVersion?: string | null;
    provisioningClass?: "customer" | "preview";
    provisionedAt?: string;
    publicIPv4?: string;
    accessClerkUserIds?: string[];
  },
): Promise<void> {
  await insertUserMachine(db, {
    machineId: input.machineId ?? `machine-${input.handle}`,
    clerkUserId: input.clerkUserId ?? "user_alice",
    handle: input.handle,
    runtimeSlot: input.runtimeSlot,
    status: input.status ?? "running",
    provisioningClass: input.provisioningClass,
    accessClerkUserIds: input.accessClerkUserIds,
    hetznerServerId: 100,
    publicIPv4: input.publicIPv4 ?? "203.0.113.10",
    imageVersion: input.imageVersion,
    serverType: "cpx22",
    provisionedAt: input.provisionedAt ?? "2026-07-11T00:00:00.000Z",
  });
}

describe("canonical computer inventory route", () => {
  let db: PlatformDB;

  beforeEach(async () => {
    db = await setupProxyRoutingTest();
  });

  afterEach(async () => {
    await cleanupProxyRoutingTest(db);
  });

  it("authenticates before listing any computer", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("wrong target", { status: 200 }),
    );
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({ verifyToken: vi.fn().mockResolvedValue(null) }),
      platformSecret: "platform-secret-123",
    });

    const response = await app.request("/api/auth/computers", {
      headers: { host: "app.matrix-os.com" },
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns a bounded safe owner projection for a verified Clerk principal", async () => {
    await insertMachine(db, {
      handle: "alice-primary",
      runtimeSlot: "primary",
      imageVersion: "v2026.07.11-private-build-data",
    });
    await insertMachine(db, {
      handle: "pr-921",
      runtimeSlot: "pr-921",
      status: "provisioning",
      imageVersion: "matrix-os-host-2026.07.10-1",
      provisioningClass: "preview",
      provisionedAt: "2026-07-11T01:00:00.000Z",
    });
    await insertMachine(db, {
      handle: "alice-review",
      runtimeSlot: "review",
      status: "stopped",
      imageVersion: "operator.internal",
      provisionedAt: "2026-07-11T02:00:00.000Z",
    });
    await insertMachine(db, {
      clerkUserId: "user_bob",
      handle: "bob-private",
      runtimeSlot: "primary",
      imageVersion: "v2026.07.11",
    });
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({
        verifyToken: vi.fn().mockResolvedValue({ sub: "user_alice" }),
      }),
      platformSecret: "platform-secret-123",
    });

    const response = await app.request("/api/auth/computers", {
      headers: {
        host: "app.matrix-os.com",
        authorization: "Bearer clerk-session",
      },
    });

    expect(response.status).toBe(200);
    const body = MatrixComputerListSchema.parse(await response.json());
    expect(body).toEqual({
      items: [
        {
          handle: "alice-primary",
          runtimeSlot: "primary",
          label: "Main Computer",
          availability: "available",
          kind: "customer",
          versionLabel: "v2026.07.11",
          gatewayPath: "/vm/alice-primary",
          capabilities: ["matrixComputerInventoryV1"],
        },
        {
          handle: "alice-review",
          runtimeSlot: "review",
          label: "Additional Computer",
          availability: "unavailable",
          kind: "customer",
          versionLabel: "Version pending",
          gatewayPath: "/vm/alice-review?runtime=review",
          capabilities: ["matrixComputerInventoryV1"],
        },
        {
          handle: "pr-921",
          runtimeSlot: "pr-921",
          label: "Preview Computer",
          availability: "starting",
          kind: "preview",
          versionLabel: "v2026.07.10",
          gatewayPath: "/vm/pr-921?runtime=pr-921",
          capabilities: ["matrixComputerInventoryV1"],
        },
      ],
      selectedSlot: null,
      hasMore: false,
      limit: 20,
    });
    expect(JSON.stringify(body)).not.toMatch(/bob|machineId|publicIPv|serverType|operator|private-build/i);
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("projects the signed runtime selection for a verified native principal", async () => {
    process.env.PLATFORM_JWT_SECRET = JWT_SECRET;
    await insertMachine(db, {
      handle: "alice-review",
      runtimeSlot: "review",
      imageVersion: "stable",
    });
    const issued = await issueSyncJwt({
      secret: JWT_SECRET,
      clerkUserId: "user_alice",
      handle: "alice-review",
      gatewayUrl: "https://app.matrix-os.com/vm/alice-review",
      runtimeSlot: "review",
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("wrong target", { status: 200 }),
    );
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({ verifyToken: vi.fn().mockResolvedValue(null) }),
      platformSecret: "platform-secret-123",
    });

    const response = await app.request("/api/auth/computers", {
      headers: {
        host: "app.matrix-os.com",
        authorization: `Bearer ${issued.token}`,
      },
    });

    expect(response.status).toBe(200);
    const body = MatrixComputerListSchema.parse(await response.json());
    expect(body.selectedSlot).toBe("review");
    expect(body.items.map((item) => item.handle)).toContain("alice-review");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("lists explicitly shared previews without exposing the owner's customer computers", async () => {
    await insertMachine(db, {
      clerkUserId: "user_bob",
      handle: "bob-primary",
      runtimeSlot: "primary",
    });
    await insertMachine(db, {
      clerkUserId: "user_bob",
      handle: "pr-1037",
      runtimeSlot: "pr-1037",
      provisioningClass: "preview",
      accessClerkUserIds: ["user_alice"],
    });
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({
        verifyToken: vi.fn().mockResolvedValue({ sub: "user_alice" }),
      }),
      platformSecret: "platform-secret-123",
    });

    const response = await app.request("/api/auth/computers", {
      headers: {
        host: "app.matrix-os.com",
        authorization: "Bearer clerk-session",
      },
    });

    expect(response.status).toBe(200);
    const body = MatrixComputerListSchema.parse(await response.json());
    expect(body.items.map((item) => item.handle)).toContain("pr-1037");
    expect(body.items.map((item) => item.handle)).not.toContain("bob-primary");
  });

  it("routes a slot-qualified computer path without moving another tab's bare API calls", async () => {
    await insertMachine(db, {
      machineId: "machine-shared-primary",
      handle: "alice-shared",
      runtimeSlot: "primary",
      publicIPv4: "203.0.113.20",
    });
    await insertMachine(db, {
      machineId: "machine-shared-review",
      handle: "alice-shared",
      runtimeSlot: "review",
      publicIPv4: "203.0.113.21",
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("review", { status: 200 }),
    );
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({
        verifyToken: vi.fn().mockResolvedValue({ sub: "user_alice" }),
      }),
      platformSecret: "platform-secret-123",
    });

    const response = await app.request("/vm/alice-shared/projects?runtime=review", {
      headers: {
        host: "app.matrix-os.com",
        authorization: "Bearer clerk-session",
      },
    });

    expect(response.status).toBe(200);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://203.0.113.21:443/projects");
    const setCookie = response.headers.get("set-cookie") ?? "";
    const handleCookie = setCookie.match(/matrix_shell_route=([^;,]+)/)?.[1];
    const slotCookie = setCookie.match(/matrix_shell_runtime_slot=([^;,]+)/)?.[1];
    expect(handleCookie).toBe("alice-shared");
    expect(slotCookie).toBe("review");

    fetchMock.mockClear();
    const followUp = await app.request("/api/projects", {
      headers: {
        host: "app.matrix-os.com",
        authorization: "Bearer clerk-session",
        cookie: `matrix_shell_route=${handleCookie}; matrix_shell_runtime_slot=${slotCookie}`,
      },
    });

    expect(followUp.status).toBe(200);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://203.0.113.20:443/api/projects");
  });

  it("routes tab-scoped slot-qualified API paths without shared cookies", async () => {
    await insertMachine(db, {
      machineId: "machine-tab-primary",
      handle: "alice-tabbed",
      runtimeSlot: "primary",
      publicIPv4: "203.0.113.30",
    });
    await insertMachine(db, {
      machineId: "machine-tab-review",
      handle: "alice-tabbed",
      runtimeSlot: "review",
      publicIPv4: "203.0.113.31",
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("review", { status: 200 }),
    );
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({
        verifyToken: vi.fn().mockResolvedValue({ sub: "user_alice" }),
      }),
      platformSecret: "platform-secret-123",
    });

    const response = await app.request(
      "/vm/alice-tabbed/~runtime/review/api/projects",
      {
        headers: {
          host: "app.matrix-os.com",
          authorization: "Bearer clerk-session",
        },
      },
    );

    expect(response.status).toBe(200);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://203.0.113.31:443/api/projects");
  });

  it("routes an existing long platform-provisioned computer handle", async () => {
    const handle = `a${"1".repeat(60)}`;
    await insertMachine(db, {
      machineId: "machine-long-handle",
      handle,
      runtimeSlot: "primary",
      publicIPv4: "203.0.113.22",
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("long handle", { status: 200 }),
    );
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({
        verifyToken: vi.fn().mockResolvedValue({ sub: "user_alice" }),
      }),
      platformSecret: "platform-secret-123",
    });

    const inventoryResponse = await app.request("/api/auth/computers", {
      headers: {
        host: "app.matrix-os.com",
        authorization: "Bearer clerk-session",
      },
    });
    expect(inventoryResponse.status).toBe(200);
    const inventory = MatrixComputerListSchema.parse(await inventoryResponse.json());
    expect(inventory.items.map((item) => item.handle)).toContain(handle);

    const response = await app.request(`/vm/${handle}/projects`, {
      headers: {
        host: "app.matrix-os.com",
        authorization: "Bearer clerk-session",
      },
    });

    expect(response.status).toBe(200);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://203.0.113.22:443/projects");
  });

  it("quarantines a malformed persisted provisioning class without hiding valid computers", async () => {
    process.env.MATRIX_LEGACY_CONTAINER_ROUTING_ENABLED = "false";
    await insertMachine(db, {
      handle: "alice-review",
      runtimeSlot: "review",
      imageVersion: "stable",
    });
    await insertMachine(db, {
      handle: "alice-corrupt",
      runtimeSlot: "primary",
      imageVersion: "stable",
      provisionedAt: "2026-07-11T01:00:00.000Z",
    });
    await sql`UPDATE user_machines SET provisioning_class = 'operator-data' WHERE handle = 'alice-corrupt'`
      .execute(db.executor);
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({
        verifyToken: vi.fn().mockResolvedValue({ sub: "user_alice" }),
      }),
      platformSecret: "platform-secret-123",
    });

    const response = await app.request("/api/auth/computers", {
      headers: {
        host: "app.matrix-os.com",
        authorization: "Bearer clerk-session",
      },
    });

    expect(response.status).toBe(200);
    const body = MatrixComputerListSchema.parse(await response.json());
    expect(body.items.map((item) => item.handle)).toEqual(["alice-review"]);
    expect(JSON.stringify(body)).not.toContain("operator-data");
  });

  it("quarantines a malformed selected machine for a verified native principal", async () => {
    process.env.PLATFORM_JWT_SECRET = JWT_SECRET;
    process.env.MATRIX_LEGACY_CONTAINER_ROUTING_ENABLED = "false";
    await insertMachine(db, {
      handle: "alice-review",
      runtimeSlot: "review",
      imageVersion: "stable",
    });
    await insertMachine(db, {
      handle: "alice-corrupt",
      runtimeSlot: "primary",
      imageVersion: "stable",
      provisionedAt: "2026-07-11T01:00:00.000Z",
    });
    await sql`UPDATE user_machines SET provisioning_class = 'operator-data' WHERE handle = 'alice-corrupt'`
      .execute(db.executor);
    const issued = await issueSyncJwt({
      secret: JWT_SECRET,
      clerkUserId: "user_alice",
      handle: "alice-corrupt",
      gatewayUrl: "https://app.matrix-os.com/vm/alice-corrupt",
      runtimeSlot: "primary",
    });
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({ verifyToken: vi.fn().mockResolvedValue(null) }),
      platformSecret: "platform-secret-123",
    });

    const response = await app.request("/api/auth/computers", {
      headers: {
        host: "app.matrix-os.com",
        authorization: `Bearer ${issued.token}`,
      },
    });

    expect(response.status).toBe(200);
    const body = MatrixComputerListSchema.parse(await response.json());
    expect(body.selectedSlot).toBeNull();
    expect(body.items.map((item) => item.handle)).toEqual(["alice-review"]);
    expect(JSON.stringify(body)).not.toContain("operator-data");
  });

  it("caps inventory at twenty records and reports remaining rows", async () => {
    for (let index = 0; index < 21; index += 1) {
      await insertMachine(db, {
        handle: `alice-${index}`,
        runtimeSlot: index === 0 ? "primary" : `slot-${index}`,
        imageVersion: "dev",
        provisionedAt: `2026-07-11T00:${String(index).padStart(2, "0")}:00.000Z`,
      });
    }
    await insertMachine(db, {
      handle: "1a",
      runtimeSlot: "invalid",
      imageVersion: "dev",
      provisionedAt: "2026-07-11T00:59:00.000Z",
    });
    await insertMachine(db, {
      handle: "alice-invalid-slot",
      runtimeSlot: "a".repeat(33),
      imageVersion: "dev",
      provisionedAt: "2026-07-11T00:58:00.000Z",
    });
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({
        verifyToken: vi.fn().mockResolvedValue({ sub: "user_alice" }),
      }),
      platformSecret: "platform-secret-123",
    });

    const response = await app.request("/api/auth/computers", {
      headers: {
        host: "app.matrix-os.com",
        authorization: "Bearer clerk-session",
      },
    });

    expect(response.status).toBe(200);
    const body = MatrixComputerListSchema.parse(await response.json());
    expect(body.items).toHaveLength(20);
    expect(body.hasMore).toBe(true);
    expect(body.limit).toBe(20);
  });

  it("keeps the verified native selection inside a capped inventory page", async () => {
    process.env.PLATFORM_JWT_SECRET = JWT_SECRET;
    await insertMachine(db, {
      handle: "alice-selected",
      runtimeSlot: "review",
      imageVersion: "stable",
      provisionedAt: "2026-07-10T00:00:00.000Z",
    });
    for (let index = 0; index < 20; index += 1) {
      await insertMachine(db, {
        handle: `alice-${index}`,
        runtimeSlot: index === 0 ? "primary" : `slot-${index}`,
        imageVersion: "dev",
        provisionedAt: `2026-07-11T00:${String(index).padStart(2, "0")}:00.000Z`,
      });
    }
    const issued = await issueSyncJwt({
      secret: JWT_SECRET,
      clerkUserId: "user_alice",
      handle: "alice-selected",
      gatewayUrl: "https://app.matrix-os.com/vm/alice-selected",
      runtimeSlot: "review",
    });
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({ verifyToken: vi.fn().mockResolvedValue(null) }),
      platformSecret: "platform-secret-123",
    });

    const response = await app.request("/api/auth/computers", {
      headers: {
        host: "app.matrix-os.com",
        authorization: `Bearer ${issued.token}`,
      },
    });

    expect(response.status).toBe(200);
    const body = MatrixComputerListSchema.parse(await response.json());
    expect(body.selectedSlot).toBe("review");
    expect(body.items.map((item) => item.runtimeSlot)).toContain("review");
    expect(body.items).toHaveLength(20);
    expect(body.hasMore).toBe(true);
  });
});
