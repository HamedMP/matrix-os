import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPreviewManager } from "../../packages/gateway/src/preview-manager.js";
import { atomicWriteJson } from "../../packages/gateway/src/state-ops.js";

describe("preview-manager", () => {
  let homePath: string;

  beforeEach(async () => {
    homePath = await mkdtemp(join(tmpdir(), "matrix-preview-manager-"));
    await atomicWriteJson(join(homePath, "system", "projects", "repo", "config.json"), {
      id: "proj_repo",
      slug: "repo",
      name: "repo",
      localPath: join(homePath, "projects", "repo"),
      addedAt: "2026-04-26T00:00:00.000Z",
      updatedAt: "2026-04-26T00:00:00.000Z",
      ownerScope: { type: "user", id: "user_a" },
    });
  });

  afterEach(() => {
    rmSync(homePath, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("saves, lists, updates, and deletes validated project and task preview URLs", async () => {
    const probeUrl = vi.fn(async () => ({ ok: true as const }));
    const manager = createPreviewManager({ homePath, probeUrl, now: () => "2026-04-26T00:00:00.000Z" });

    const created = await manager.createPreview("repo", {
      taskId: "task_abc123",
      sessionId: "sess_abc123",
      label: "Local app",
      url: "http://localhost:3000",
      displayPreference: "panel",
    });

    expect(created).toMatchObject({
      ok: true,
      status: 201,
      preview: {
        projectSlug: "repo",
        taskId: "task_abc123",
        sessionId: "sess_abc123",
        label: "Local app",
        url: "http://localhost:3000",
        lastStatus: "ok",
        displayPreference: "panel",
      },
    });
    expect(probeUrl).toHaveBeenCalledWith("http://localhost:3000", { timeoutMs: 10_000 });
    await expect(manager.listPreviews("repo", { taskId: "task_abc123" })).resolves.toMatchObject({
      ok: true,
      previews: [expect.objectContaining({ label: "Local app" })],
      nextCursor: null,
    });

    if (!created.ok) return;
    await expect(manager.updatePreview("repo", created.preview.id, {
      label: "External app",
      displayPreference: "external",
      lastStatus: "failed",
    })).resolves.toMatchObject({
      ok: true,
      preview: { label: "External app", displayPreference: "external", lastStatus: "failed" },
    });
    await expect(manager.deletePreview("repo", created.preview.id)).resolves.toMatchObject({ ok: true });
    await expect(stat(join(homePath, "system", "projects", "repo", "previews", `${created.preview.id}.json`))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects unsafe preview URLs and exposes probe failures as recoverable status", async () => {
    const probeUrl = vi.fn(async () => ({ ok: false as const, code: "preview_probe_failed" }));
    const manager = createPreviewManager({
      homePath,
      probeUrl,
    });

    await expect(manager.createPreview("repo", { label: "File", url: "file:///etc/passwd" })).resolves.toMatchObject({
      ok: false,
      status: 400,
      error: { code: "invalid_preview_url" },
    });
    await expect(manager.createPreview("ghost-project", { label: "Missing", url: "http://localhost:3000" })).resolves.toMatchObject({
      ok: false,
      status: 404,
      error: { code: "not_found" },
    });
    await expect(manager.createPreview("repo", { label: "Metadata", url: "http://169.254.169.254/latest/meta-data" })).resolves.toMatchObject({
      ok: false,
      status: 400,
      error: { code: "invalid_preview_url" },
    });
    await expect(stat(join(homePath, "projects", "ghost-project"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(manager.createPreview("repo", { label: "Down", url: "https://localhost:3000" })).resolves.toMatchObject({
      ok: true,
      preview: { lastStatus: "failed" },
    });
    expect(probeUrl).toHaveBeenCalledTimes(1);
  });

  it("keeps legacy previews readable and adopts valid records into the registry", async () => {
    const legacy = {
      id: "prev_legacy123",
      projectSlug: "repo",
      label: "Legacy preview",
      url: "http://localhost:3000",
      lastStatus: "ok",
      displayPreference: "panel",
      createdAt: "2026-04-25T00:00:00.000Z",
      updatedAt: "2026-04-25T00:00:00.000Z",
    };
    await atomicWriteJson(join(homePath, "projects", "repo", "previews", `${legacy.id}.json`), legacy);
    const manager = createPreviewManager({ homePath, probeUrl: vi.fn(async () => ({ ok: true as const })) });

    await expect(manager.listPreviews("repo")).resolves.toMatchObject({
      ok: true,
      previews: [expect.objectContaining({ id: legacy.id, label: "Legacy preview" })],
    });
    await expect(readFile(
      join(homePath, "system", "projects", "repo", "previews", `${legacy.id}.json`),
      "utf-8",
    )).resolves.toContain("Legacy preview");
    await expect(manager.deletePreview("repo", legacy.id)).resolves.toEqual({ ok: true });
    await expect(manager.listPreviews("repo")).resolves.toMatchObject({ previews: [] });
  });

  it("preserves an unvalidated owner file that collides with a canonical preview id", async () => {
    const manager = createPreviewManager({
      homePath,
      probeUrl: vi.fn(async () => ({ ok: true as const })),
    });
    const created = await manager.createPreview("repo", {
      label: "Canonical preview",
      url: "http://localhost:3000",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const ownerFile = join(homePath, "projects", "repo", "previews", `${created.preview.id}.json`);
    await atomicWriteJson(ownerFile, { ownerNote: "keep me" });

    await expect(manager.deletePreview("repo", created.preview.id)).resolves.toEqual({ ok: true });
    await expect(readFile(ownerFile, "utf-8")).resolves.toContain("keep me");
    await expect(stat(
      join(homePath, "system", "projects", "repo", "previews", `${created.preview.id}.json`),
    )).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects preview mutations from a different owner scope", async () => {
    const manager = createPreviewManager({
      homePath,
      probeUrl: vi.fn(async () => ({ ok: true as const })),
    });

    await expect(manager.createPreview(
      "repo",
      { label: "Do not create", url: "http://localhost:3000" },
      { type: "user", id: "user_b" },
    )).resolves.toMatchObject({ ok: false, status: 404, error: { code: "not_found" } });
  });

  it("enforces project and task preview caps and detects preview URLs from session output", async () => {
    const manager = createPreviewManager({
      homePath,
      maxPreviewsPerProject: 2,
      maxPreviewsPerTask: 1,
      probeUrl: vi.fn(async () => ({ ok: true as const })),
    });

    await expect(manager.createPreview("repo", { taskId: "task_abc123", label: "One", url: "http://localhost:3000" })).resolves.toMatchObject({ ok: true });
    await expect(manager.createPreview("repo", { taskId: "task_abc123", label: "Two", url: "http://localhost:3001" })).resolves.toMatchObject({
      ok: false,
      status: 409,
      error: { code: "preview_limit_exceeded" },
    });
    await expect(manager.createPreview("repo", { label: "Two", url: "http://127.0.0.1:3002" })).resolves.toMatchObject({ ok: true });
    await expect(manager.createPreview("repo", { label: "Three", url: "http://localhost:3003" })).resolves.toMatchObject({
      ok: false,
      status: 409,
      error: { code: "preview_limit_exceeded" },
    });

    expect(manager.detectPreviewUrls("ready on http://localhost:5173 and https://127.0.0.1:8443/docs")).toEqual([
      "http://localhost:5173",
      "https://127.0.0.1:8443/docs",
    ]);
  });

  it("lists recent previews newest-first across large project history", async () => {
    const manager = createPreviewManager({ homePath });
    for (let index = 0; index < 260; index += 1) {
      await atomicWriteJson(join(homePath, "system", "projects", "repo", "previews", `prev_old_${index}.json`), {
        id: `prev_old_${index}`,
        projectSlug: "repo",
        label: `Old preview ${index}`,
        url: "http://localhost:3000",
        lastStatus: "ok",
        displayPreference: "panel",
        createdAt: new Date(Date.UTC(2026, 3, 26, 0, 0, index % 60)).toISOString(),
        updatedAt: new Date(Date.UTC(2026, 3, 26, 0, 0, index % 60)).toISOString(),
      });
    }
    await atomicWriteJson(join(homePath, "system", "projects", "repo", "previews", "prev_newest.json"), {
      id: "prev_newest",
      projectSlug: "repo",
      label: "Newest preview",
      url: "http://localhost:4000",
      lastStatus: "ok",
      displayPreference: "panel",
      createdAt: "2026-04-26T00:00:00.000Z",
      updatedAt: "2026-04-26T01:00:00.000Z",
    });

    const result = await manager.listRecentPreviews("repo", { limit: 50 });

    expect(result).toMatchObject({
      ok: true,
      nextCursor: expect.any(String),
    });
    expect(result.ok && result.previews[0]).toMatchObject({
      id: "prev_newest",
      label: "Newest preview",
    });
  });

  it("fails safely when preview identifier discovery exceeds its memory bound", async () => {
    const directory = join(homePath, "system", "projects", "repo", "previews");
    await mkdir(directory, { recursive: true });
    await Promise.all(Array.from({ length: 513 }, (_, index) => (
      writeFile(join(directory, `prev_untrusted_${index}.json`), "{}", "utf-8")
    )));
    const manager = createPreviewManager({ homePath });

    await expect(manager.listPreviews("repo")).resolves.toMatchObject({
      ok: false,
      status: 409,
      error: { code: "preview_limit_exceeded" },
    });
  });
});
