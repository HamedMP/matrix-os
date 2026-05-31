import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  SelectToolPacksRequestSchema,
  ToolPacksResponseSchema,
} from "../../packages/gateway/src/onboarding/activation-contracts.js";
import { createToolPackRoutes } from "../../packages/gateway/src/onboarding/tool-pack-routes.js";
import {
  InMemoryToolPackRepository,
  createHostToolPackInstaller,
  createToolPackService,
  type ToolPackInstaller,
  type ToolPackRecord,
  type ToolPackRepository,
} from "../../packages/gateway/src/onboarding/tool-packs.js";
import { testPrincipal } from "../helpers/activation-readiness.js";

function jsonRequest(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

class FailingSettlementRepository implements ToolPackRepository {
  private record: ToolPackRecord | null = null;
  private shouldFailSettlement = true;

  async get(): Promise<ToolPackRecord | null> {
    return this.record ? structuredClone(this.record) : null;
  }

  async save(record: ToolPackRecord): Promise<ToolPackRecord> {
    this.record = structuredClone(record);
    return structuredClone(record);
  }

  async update(ownerId: string, updater: (record: ToolPackRecord | null) => ToolPackRecord): Promise<ToolPackRecord> {
    const current = this.record ? structuredClone(this.record) : null;
    const next = updater(current);
    const settlingJob = current?.installJobs.some((job) => job.status === "installing")
      && next.installJobs.some((job) => job.status !== "installing");

    if (this.shouldFailSettlement && settlingJob) {
      this.shouldFailSettlement = false;
      throw new Error("settlement write failed");
    }

    if (next.ownerId !== ownerId) {
      throw new Error("owner mismatch");
    }
    return this.save(next);
  }
}

describe("onboarding tool packs", () => {
  it("exposes selectable boot-time tool packs without requiring every tool in the bundle", async () => {
    const service = createToolPackService({
      repository: new InMemoryToolPackRepository(),
      now: () => new Date("2026-05-31T00:00:00.000Z"),
    });

    const response = await service.listToolPacks(testPrincipal.userId);

    expect(() => ToolPacksResponseSchema.parse(response)).not.toThrow();
    expect(response.packs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "coding-agents",
        status: "available",
        selected: false,
        commands: ["claude", "codex", "opencode", "pi"],
      }),
      expect.objectContaining({
        id: "hermes",
        category: "agent",
        status: "selected",
        selected: true,
      }),
      expect.objectContaining({
        id: "code-server",
        category: "editor",
        status: "available",
      }),
    ]));
    expect(response.selectedPackIds).toEqual(["hermes"]);
  });

  it("validates bounded tool selections and preserves selected pack order", async () => {
    expect(() => SelectToolPacksRequestSchema.parse({
      packIds: ["coding-agents", "code-server", "hermes"],
    })).not.toThrow();
    expect(() => SelectToolPacksRequestSchema.parse({ packIds: [] })).toThrow();
    expect(() => SelectToolPacksRequestSchema.parse({ packIds: ["../../bin/sh"] })).toThrow();

    const service = createToolPackService({
      repository: new InMemoryToolPackRepository(),
      now: () => new Date("2026-05-31T00:00:00.000Z"),
    });
    const response = await service.selectToolPacks(testPrincipal.userId, [
      "coding-agents",
      "hermes",
      "coding-agents",
    ]);

    expect(response.selectedPackIds).toEqual(["coding-agents", "hermes"]);
    expect(response.packs.find((pack) => pack.id === "coding-agents")).toMatchObject({
      selected: true,
      status: "selected",
    });
  });

  it("starts selected tool installs in parallel and returns live job state", async () => {
    const started: string[] = [];
    const installer: ToolPackInstaller = {
      install: async (_ownerId, packId) => {
        started.push(packId);
      },
    };
    const service = createToolPackService({
      repository: new InMemoryToolPackRepository(),
      installer,
      now: () => new Date("2026-05-31T00:00:00.000Z"),
    });

    const response = await service.installToolPacks(testPrincipal.userId, ["coding-agents", "code-server"]);

    expect(response.installJobs).toHaveLength(2);
    expect(response.installJobs.map((job) => job.status)).toEqual(["installing", "installing"]);
    expect(response.packs.find((pack) => pack.id === "coding-agents")).toMatchObject({
      selected: true,
      status: "installing",
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    const completed = await service.listToolPacks(testPrincipal.userId);

    expect(started).toEqual(expect.arrayContaining(["coding-agents", "code-server"]));
    expect(completed.installJobs.map((job) => job.status)).toEqual(["installed", "installed"]);
    expect(completed.packs.find((pack) => pack.id === "code-server")).toMatchObject({
      installed: true,
      status: "installed",
    });
  });

  it("does not let a duplicate install collision shadow the active or completed job", async () => {
    const repository = new InMemoryToolPackRepository();
    let currentTime = new Date("2026-05-31T00:00:02.000Z");
    const service = createToolPackService({
      repository,
      now: () => currentTime,
    });
    const baseRecord: ToolPackRecord = {
      ownerId: testPrincipal.userId,
      selectedPackIds: ["hermes", "coding-agents"],
      updatedAt: "2026-05-31T00:00:01.000Z",
      installJobs: [
        {
          id: "first-install",
          packId: "coding-agents",
          status: "installing",
          startedAt: "2026-05-31T00:00:00.000Z",
          completedAt: null,
          message: null,
        },
        {
          id: "lock-collision",
          packId: "coding-agents",
          status: "failed",
          startedAt: "2026-05-31T00:00:01.000Z",
          completedAt: "2026-05-31T00:00:01.500Z",
          message: "Install failed",
        },
      ],
    };
    await repository.save(baseRecord);

    const duringInstall = await service.listToolPacks(testPrincipal.userId);

    expect(duringInstall.packs.find((pack) => pack.id === "coding-agents")).toMatchObject({
      installJobId: "first-install",
      status: "installing",
    });

    await repository.save({
      ...baseRecord,
      installJobs: baseRecord.installJobs.map((job) => job.id === "first-install"
        ? {
            ...job,
            status: "installed",
            completedAt: "2026-05-31T00:00:03.000Z",
            message: "Installed",
          }
        : job),
    });
    currentTime = new Date("2026-05-31T00:00:04.000Z");
    const afterInstall = await service.listToolPacks(testPrincipal.userId);

    expect(afterInstall.packs.find((pack) => pack.id === "coding-agents")).toMatchObject({
      installJobId: "first-install",
      installed: true,
      status: "installed",
    });

    await repository.save({
      ...baseRecord,
      installJobs: [
        {
          ...baseRecord.installJobs[0]!,
          status: "installed",
          completedAt: "2026-05-31T00:00:03.000Z",
          message: "Installed",
        },
        {
          ...baseRecord.installJobs[1]!,
          completedAt: "2026-05-31T00:00:04.000Z",
        },
      ],
    });
    currentTime = new Date("2026-05-31T00:00:05.000Z");
    const afterFailedRetry = await service.listToolPacks(testPrincipal.userId);

    expect(afterFailedRetry.packs.find((pack) => pack.id === "coding-agents")).toMatchObject({
      installJobId: "lock-collision",
      installed: true,
      status: "failed",
    });
  });

  it("deduplicates install requests for packs that are already installing", async () => {
    const started: string[] = [];
    let releaseInstall: (() => void) | null = null;
    const installer: ToolPackInstaller = {
      install: async (_ownerId, packId) => {
        started.push(packId);
        await new Promise<void>((resolve) => {
          releaseInstall = resolve;
        });
      },
    };
    const service = createToolPackService({
      repository: new InMemoryToolPackRepository(),
      installer,
      now: () => new Date("2026-05-31T00:00:00.000Z"),
    });

    const first = await service.installToolPacks(testPrincipal.userId, ["coding-agents"]);
    const second = await service.installToolPacks(testPrincipal.userId, ["coding-agents"]);

    expect(first.installJobs).toHaveLength(1);
    expect(second.installJobs).toHaveLength(1);
    expect(second.installJobs[0]).toMatchObject({
      packId: "coding-agents",
      status: "installing",
    });
    expect(started).toEqual(["coding-agents"]);

    releaseInstall?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("uses the existing Linux tools service timeout budget for host installs", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "matrix-tool-pack-installer-"));
    const scriptPath = join(tempDir, "installer");
    await writeFile(scriptPath, [
      "#!/usr/bin/env bash",
      "if [ \"$1\" = \"linux-tools\" ]; then",
      "  sleep 0.1",
      "else",
      "  sleep 1",
      "fi",
      "",
    ].join("\n"));
    await chmod(scriptPath, 0o755);

    try {
      const installer = createHostToolPackInstaller({
        scriptPath,
        timeoutMs: 50,
        linuxToolsTimeoutMs: 500,
      });

      await installer.install(testPrincipal.userId, "linux-tools");
      await expect(installer.install(testPrincipal.userId, "code-server")).rejects.toThrow(
        "tool pack install timed out for code-server",
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("expires installing jobs if the async settlement write fails", async () => {
    let currentTime = new Date("2026-05-31T00:00:00.000Z");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const service = createToolPackService({
      repository: new FailingSettlementRepository(),
      installer: { install: async () => {} },
      installTimeoutMs: 1_000,
      now: () => currentTime,
    });

    try {
      const response = await service.installToolPacks(testPrincipal.userId, ["coding-agents"]);

      expect(response.installJobs).toEqual([
        expect.objectContaining({ packId: "coding-agents", status: "installing" }),
      ]);

      await new Promise((resolve) => setTimeout(resolve, 0));
      currentTime = new Date("2026-05-31T00:00:02.000Z");
      const expired = await service.listToolPacks(testPrincipal.userId);

      expect(expired.installJobs).toEqual([
        expect.objectContaining({
          packId: "coding-agents",
          status: "failed",
          message: "Install status unavailable",
        }),
      ]);
      expect(expired.packs.find((pack) => pack.id === "coding-agents")).toMatchObject({
        status: "failed",
      });
      expect(warnSpy).toHaveBeenCalledWith(
        "[onboarding] tool pack job status update failed:",
        "settlement write failed",
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("routes selection and install requests through owner-scoped onboarding APIs", async () => {
    const service = createToolPackService({
      repository: new InMemoryToolPackRepository(),
      installer: { install: async () => {} },
      now: () => new Date("2026-05-31T00:00:00.000Z"),
    });
    const app = createToolPackRoutes({ service, getPrincipal: () => testPrincipal });

    const selection = await app.request(jsonRequest("/tools/selection", {
      packIds: ["coding-agents", "hermes"],
    }));
    expect(selection.status).toBe(200);
    await expect(selection.json()).resolves.toMatchObject({
      selectedPackIds: ["coding-agents", "hermes"],
    });

    const install = await app.request(jsonRequest("/tools/install", {
      packIds: ["coding-agents"],
    }));
    expect(install.status).toBe(202);
    await expect(install.json()).resolves.toMatchObject({
      selectedPackIds: ["coding-agents", "hermes"],
      installJobs: [expect.objectContaining({ packId: "coding-agents", status: "installing" })],
    });
  });

  it("rejects invalid tool pack route payloads with a generic client-safe error", async () => {
    const service = createToolPackService({
      repository: new InMemoryToolPackRepository(),
      now: () => new Date("2026-05-31T00:00:00.000Z"),
    });
    const app = createToolPackRoutes({ service, getPrincipal: () => testPrincipal });

    const res = await app.request(jsonRequest("/tools/selection", {
      packIds: ["../../secrets"],
    }));

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: "invalid_request",
      message: "Request is invalid",
      retryable: false,
    });
  });
});
