import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerFileManagementRoutes } from "../../packages/gateway/src/server/file-management-routes.js";
import { registerFileRoutes } from "../../packages/gateway/src/server/file-routes.js";
import { FileBatchMoveService } from "../../packages/gateway/src/file-management/batch-service.js";
import { FileBatchPreflightUnavailableError } from "../../packages/gateway/src/file-management/preflight.js";
import {
  TrashManifestQueueCapacityError,
  TrashManifestQueueClosedError,
} from "../../packages/gateway/src/trash.js";
import {
  MissingRequestPrincipalError,
  RequestPrincipalMisconfiguredError,
} from "../../packages/gateway/src/request-principal.js";

const requestId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function jsonRequest(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("file-management HTTP routes", () => {
  const cleanupPaths: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it("registers the typed create route and binds it to the authenticated owner", async () => {
    const createFile = vi.fn().mockResolvedValue({
      ok: true,
      path: "projects/notes.md",
      resultCode: "created",
      capabilities: { canRename: true, canMove: true, canTrash: true },
    });
    const getOwnerId = vi.fn().mockReturnValue("owner-a");
    const app = new Hono();
    registerFileManagementRoutes(app, {
      homePath: "/owner/home",
      getOwnerId,
      createFile,
    });

    const response = await app.request(jsonRequest("/api/files/create", {
        requestId,
        parentDirectory: "projects",
        name: "notes.md",
        kind: "file",
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      path: "projects/notes.md",
      resultCode: "created",
    });
    expect(getOwnerId).toHaveBeenCalledOnce();
    expect(createFile).toHaveBeenCalledWith("/owner/home", expect.objectContaining({ name: "notes.md" }));
  });

  it.each([
    [new MissingRequestPrincipalError(), 401, { error: "Unauthorized" }],
    [new RequestPrincipalMisconfiguredError(), 500, { error: "File operation failed" }],
  ])("maps an absent or misconfigured owner dependency safely", async (principalError, status, body) => {
    const createFile = vi.fn();
    const app = new Hono();
    registerFileManagementRoutes(app, {
      homePath: "/owner/home",
      getOwnerId: () => { throw principalError; },
      createFile,
    });

    const response = await app.request(jsonRequest("/api/files/create", {
      requestId,
      parentDirectory: "projects",
      name: "notes.md",
      kind: "file",
    }));

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual(body);
    expect(createFile).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON and schema errors with a bounded generic body", async () => {
    const createFile = vi.fn();
    const app = new Hono();
    registerFileManagementRoutes(app, {
      homePath: "/owner/home",
      getOwnerId: () => "owner-a",
      createFile,
    });

    const malformed = await app.request("/api/files/create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not-json",
    });
    const invalid = await app.request(jsonRequest("/api/files/create", {
      requestId,
      parentDirectory: "projects",
      name: "../escape",
      kind: "file",
    }));

    expect(malformed.status).toBe(400);
    expect(invalid.status).toBe(400);
    await expect(malformed.json()).resolves.toEqual({ error: "Invalid request", code: "invalid_request" });
    await expect(invalid.json()).resolves.toEqual({ error: "Invalid request", code: "invalid_request" });
    expect(createFile).not.toHaveBeenCalled();
  });

  it("rejects an actually streamed body larger than 128 KiB before JSON parsing", async () => {
    const createFile = vi.fn();
    const app = new Hono();
    registerFileManagementRoutes(app, {
      homePath: "/owner/home",
      getOwnerId: () => "owner-a",
      createFile,
    });
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < 129; index += 1) controller.enqueue(encoder.encode("x".repeat(1024)));
        controller.close();
      },
    });
    const oversized = new Request("http://localhost/api/files/create", {
      method: "POST",
      headers: { "content-type": "application/json", "transfer-encoding": "chunked" },
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    const response = await app.request(oversized);

    expect(response.status).toBe(413);
    expect(createFile).not.toHaveBeenCalled();
  });

  it("routes typed rename results with fresh capabilities and safe protected/conflict codes", async () => {
    const renameFile = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        path: "projects/new.md",
        resultCode: "renamed",
        capabilities: { canRename: true, canMove: true, canTrash: true },
      })
      .mockResolvedValueOnce({ ok: false, errorCode: "protected" })
      .mockResolvedValueOnce({ ok: false, errorCode: "destination_conflict" });
    const app = new Hono();
    registerFileManagementRoutes(app, {
      homePath: "/owner/home",
      getOwnerId: () => "owner-a",
      renameFile,
    });
    const typedBody = { requestId, path: "projects/old.md", name: "new.md" };

    const success = await app.request(jsonRequest("/api/files/rename", typedBody));
    const protectedTarget = await app.request(jsonRequest("/api/files/rename", typedBody));
    const occupiedTarget = await app.request(jsonRequest("/api/files/rename", typedBody));

    expect(success.status).toBe(200);
    await expect(success.json()).resolves.toMatchObject({
      ok: true,
      path: "projects/new.md",
      resultCode: "renamed",
      capabilities: { canRename: true, canMove: true, canTrash: true },
    });
    expect(protectedTarget.status).toBe(403);
    await expect(protectedTarget.json()).resolves.toEqual({ ok: false, errorCode: "protected" });
    expect(occupiedTarget.status).toBe(409);
    await expect(occupiedTarget.json()).resolves.toEqual({ ok: false, errorCode: "destination_conflict" });
    expect(renameFile).toHaveBeenCalledTimes(3);
  });

  it("preserves the legacy from/to rename contract at the same route boundary", async () => {
    const legacyRenameFile = vi.fn().mockResolvedValue({ ok: true });
    const typedRenameFile = vi.fn();
    const app = new Hono();
    registerFileManagementRoutes(app, {
      homePath: "/owner/home",
      getOwnerId: () => "owner-a",
      renameFile: typedRenameFile,
      legacyRenameFile,
    });

    const response = await app.request(jsonRequest("/api/files/rename", {
      from: "projects/old.md",
      to: "projects/new.md",
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(legacyRenameFile).toHaveBeenCalledWith("/owner/home", "projects/old.md", "projects/new.md");
    expect(typedRenameFile).not.toHaveBeenCalled();
  });

  it.each([
    { from: "../outside.md", to: "projects/new.md" },
    { from: "/absolute.md", to: "projects/new.md" },
    { from: "projects/old.md", to: "projects\\new.md" },
  ])("rejects unsafe legacy rename paths at the route boundary", async (body) => {
    const legacyRenameFile = vi.fn();
    const app = new Hono();
    registerFileManagementRoutes(app, {
      homePath: "/owner/home",
      getOwnerId: () => "owner-a",
      legacyRenameFile,
    });

    const response = await app.request(jsonRequest("/api/files/rename", body));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid request", code: "invalid_request" });
    expect(legacyRenameFile).not.toHaveBeenCalled();
  });

  it.each([
    new TrashManifestQueueCapacityError(),
    new TrashManifestQueueClosedError(),
  ])("maps typed Trash queue admission failures to temporary unavailability", async (queueError) => {
    const trashService = {
      trash: vi.fn().mockRejectedValue(queueError),
      delete: vi.fn(),
      list: vi.fn(),
      restore: vi.fn(),
      empty: vi.fn(),
      close: vi.fn(),
    };
    const app = new Hono();
    registerFileManagementRoutes(app, {
      homePath: "/owner/home",
      getOwnerId: () => "owner-a",
      trashService,
    });

    const response = await app.request(jsonRequest("/api/files/batch/trash", {
      requestId,
      sources: ["projects/old.md"],
    }));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "File operation unavailable",
      code: "operation_unavailable",
    });
  });

  it.each([
    new TrashManifestQueueCapacityError(),
    new TrashManifestQueueClosedError(),
  ])("maps legacy Trash queue admission failures to temporary unavailability", async (queueError) => {
    const trashService = {
      trash: vi.fn(),
      delete: vi.fn().mockRejectedValue(queueError),
      list: vi.fn(),
      restore: vi.fn(),
      empty: vi.fn(),
      close: vi.fn(),
    };
    const app = new Hono();
    registerFileRoutes(app, { homePath: "/owner/home", trashService });

    const response = await app.request(jsonRequest("/api/files/delete", {
      path: "projects/legacy.md",
    }));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "File operation unavailable",
      code: "operation_unavailable",
    });
  });

  it("routes move preflight and execute through one service and requires the fingerprint", async () => {
    const moveService = {
      preflight: vi.fn().mockResolvedValue({
        sources: ["projects/a.md"],
        destinationDirectory: "archive",
        conflicts: [],
        invalid: [],
        preflightFingerprint: "fingerprint-a",
      }),
      execute: vi.fn().mockResolvedValue({
        results: [{ source: "projects/a.md", code: "moved", path: "archive/a.md" }],
        affectedDirectories: ["projects", "archive"],
      }),
      close: vi.fn(),
    };
    const app = new Hono();
    registerFileManagementRoutes(app, {
      homePath: "/owner/home",
      getOwnerId: () => "owner-a",
      moveService,
    });
    const preflightBody = {
      requestId,
      phase: "preflight",
      sources: ["projects/a.md"],
      destinationDirectory: "archive",
    };

    const preflight = await app.request(jsonRequest("/api/files/batch/move", preflightBody));
    const missingFingerprint = await app.request(jsonRequest("/api/files/batch/move", {
      requestId,
      phase: "execute",
    }));
    const execute = await app.request(jsonRequest("/api/files/batch/move", {
      requestId,
      phase: "execute",
      preflightFingerprint: "fingerprint-a",
    }));

    expect(preflight.status).toBe(200);
    expect(missingFingerprint.status).toBe(400);
    expect(execute.status).toBe(200);
    expect(moveService.preflight).toHaveBeenCalledWith({
      ownerId: "owner-a",
      homePath: "/owner/home",
      requestId,
      sources: ["projects/a.md"],
      destinationDirectory: "archive",
    });
    expect(moveService.execute).toHaveBeenCalledWith({
      ownerId: "owner-a",
      homePath: "/owner/home",
      requestId,
      preflightFingerprint: "fingerprint-a",
    });
  });

  it("keeps move replay owner-scoped and maps payload mismatches to a safe conflict", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "file-management-routes-"));
    cleanupPaths.push(homePath);
    await mkdir(join(homePath, "projects"));
    await mkdir(join(homePath, "archive"));
    await mkdir(join(homePath, "other"));
    await writeFile(join(homePath, "projects", "a.md"), "a");
    const moveService = new FileBatchMoveService();
    let ownerId = "owner-a";
    const app = new Hono();
    registerFileManagementRoutes(app, {
      homePath,
      getOwnerId: () => ownerId,
      moveService,
    });
    const original = {
      requestId,
      phase: "preflight",
      sources: ["projects/a.md"],
      destinationDirectory: "archive",
    };

    const first = await app.request(jsonRequest("/api/files/batch/move", original));
    const replay = await app.request(jsonRequest("/api/files/batch/move", original));
    const mismatch = await app.request(jsonRequest("/api/files/batch/move", {
      ...original,
      destinationDirectory: "other",
    }));
    ownerId = "owner-b";
    const crossOwner = await app.request(jsonRequest("/api/files/batch/move", {
      ...original,
      destinationDirectory: "other",
    }));
    moveService.close();

    expect(first.status).toBe(200);
    expect(await replay.json()).toEqual(await first.json());
    expect(mismatch.status).toBe(409);
    await expect(mismatch.json()).resolves.toEqual({
      error: "Request identifier conflict",
      code: "request_id_conflict",
    });
    expect(crossOwner.status).toBe(200);
    await expect(crossOwner.json()).resolves.toMatchObject({ destinationDirectory: "other" });
  });

  it("returns ordered batch Trash results and shares one service with every legacy Trash route", async () => {
    const trashService = {
      trash: vi.fn().mockResolvedValue({
        results: [
          { source: "projects/a.md", code: "trashed" },
          { source: "projects/b.md", code: "source_missing" },
        ],
        sourceDirectory: "projects",
      }),
      delete: vi.fn().mockResolvedValue({ ok: true, trashPath: ".trash/legacy.md" }),
      list: vi.fn().mockResolvedValue({ entries: [] }),
      restore: vi.fn().mockResolvedValue({ ok: true, restoredTo: "projects/legacy.md" }),
      empty: vi.fn().mockResolvedValue({ ok: true, deleted: 1 }),
      close: vi.fn(),
    };
    const app = new Hono();
    const registry = registerFileManagementRoutes(app, {
      homePath: "/owner/home",
      getOwnerId: () => "owner-a",
      trashService,
    });
    registerFileRoutes(app, { homePath: "/owner/home", trashService: registry.trashService });

    const batch = await app.request(jsonRequest("/api/files/batch/trash", {
      requestId,
      sources: ["projects/a.md", "projects/b.md"],
    }));
    const legacyDelete = await app.request(jsonRequest("/api/files/delete", { path: "projects/legacy.md" }));
    const list = await app.request("/api/files/trash");
    const restore = await app.request(jsonRequest("/api/files/trash/restore", { trashPath: ".trash/legacy.md" }));
    const empty = await app.request(jsonRequest("/api/files/trash/empty", {}));

    expect(batch.status).toBe(200);
    await expect(batch.json()).resolves.toMatchObject({
      results: [{ source: "projects/a.md", code: "trashed" }, { source: "projects/b.md", code: "source_missing" }],
    });
    expect([legacyDelete.status, list.status, restore.status, empty.status]).toEqual([200, 200, 200, 200]);
    expect(trashService.trash).toHaveBeenCalledWith(expect.objectContaining({ ownerId: "owner-a" }));
    expect(trashService.delete).toHaveBeenCalledWith("/owner/home", "projects/legacy.md");
    expect(trashService.list).toHaveBeenCalledWith("/owner/home");
    expect(trashService.restore).toHaveBeenCalledWith("/owner/home", ".trash/legacy.md");
    expect(trashService.empty).toHaveBeenCalledWith("/owner/home");
  });

  it("applies the 128 KiB limit to legacy Trash mutations", async () => {
    const trashService = {
      trash: vi.fn(), delete: vi.fn(), list: vi.fn(), restore: vi.fn(), empty: vi.fn(), close: vi.fn(),
    };
    const app = new Hono();
    registerFileRoutes(app, { homePath: "/owner/home", trashService });

    const response = await app.request(jsonRequest("/api/files/delete", {
      path: "projects/a.md",
      padding: "x".repeat(129 * 1024),
    }));

    expect(response.status).toBe(413);
    expect(trashService.delete).not.toHaveBeenCalled();
  });

  it("keeps list response compatibility and includes capabilities on every visible entry", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "file-list-capabilities-"));
    cleanupPaths.push(homePath);
    await mkdir(join(homePath, "system"));
    await mkdir(join(homePath, "projects"));
    await writeFile(join(homePath, "notes.md"), "notes");
    const app = new Hono();
    registerFileRoutes(app, {
      homePath,
      trashService: {
        trash: vi.fn(), delete: vi.fn(), list: vi.fn(), restore: vi.fn(), empty: vi.fn(), close: vi.fn(),
      },
    });

    const response = await app.request("/api/files/list?path=");
    const body = await response.json() as { path: string; entries: Array<{ name: string; capabilities?: unknown }> };

    expect(response.status).toBe(200);
    expect(body.path).toBe("");
    expect(body.entries.length).toBeGreaterThan(0);
    expect(body.entries.every((entry) => entry.capabilities !== undefined)).toBe(true);
    expect(body.entries.find((entry) => entry.name === "system")?.capabilities).toEqual({
      canRename: false,
      canMove: false,
      canTrash: false,
      readOnlyReason: "protected",
    });
  });

  it("closes owned services once, leaves injected services caller-owned, and hides raw failures", async () => {
    const injectedMove = { preflight: vi.fn(), execute: vi.fn(), close: vi.fn() };
    const injectedTrash = {
      trash: vi.fn().mockRejectedValue(new Error("/private/home/provider failure")),
      delete: vi.fn(), list: vi.fn(), restore: vi.fn(), empty: vi.fn(), close: vi.fn(),
    };
    const ownedMove = { preflight: vi.fn(), execute: vi.fn(), close: vi.fn() };
    const ownedTrash = {
      trash: vi.fn(), delete: vi.fn(), list: vi.fn(), restore: vi.fn(), empty: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const app = new Hono();
    const injectedRegistry = registerFileManagementRoutes(app, {
      homePath: "/owner/home",
      getOwnerId: () => "owner-a",
      moveService: injectedMove,
      trashService: injectedTrash,
    });
    const ownedRegistry = registerFileManagementRoutes(new Hono(), {
      homePath: "/owner/home",
      getOwnerId: () => "owner-a",
      createMoveService: () => ownedMove,
      createTrashService: () => ownedTrash,
    });

    const failure = await app.request(jsonRequest("/api/files/batch/trash", {
      requestId,
      sources: ["projects/a.md"],
    }));
    await Promise.all([injectedRegistry.close(), injectedRegistry.close()]);
    await Promise.all([ownedRegistry.close(), ownedRegistry.close()]);

    expect(failure.status).toBe(500);
    expect(JSON.stringify(await failure.json())).not.toContain("private");
    expect(injectedMove.close).not.toHaveBeenCalled();
    expect(injectedTrash.close).not.toHaveBeenCalled();
    expect(ownedMove.close).toHaveBeenCalledOnce();
    expect(ownedTrash.close).toHaveBeenCalledOnce();
  });

  it("preserves the stable failed code for typed preflight service failures", async () => {
    const app = new Hono();
    registerFileManagementRoutes(app, {
      homePath: "/owner/home",
      getOwnerId: () => "owner-a",
      moveService: {
        preflight: vi.fn().mockRejectedValue(new FileBatchPreflightUnavailableError()),
        execute: vi.fn(),
        close: vi.fn(),
      },
    });

    const response = await app.request(jsonRequest("/api/files/batch/move", {
      requestId,
      phase: "preflight",
      sources: ["projects/a.md"],
      destinationDirectory: "archive",
    }));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "File operation failed", code: "failed" });
  });
});
