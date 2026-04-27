import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, stat } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPreviewManager } from "../../packages/gateway/src/preview-manager.js";

describe("preview-manager", () => {
  let homePath: string;

  beforeEach(async () => {
    homePath = await mkdtemp(join(tmpdir(), "matrix-preview-manager-"));
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
    await expect(stat(join(homePath, "projects", "repo", "previews", `${created.preview.id}.json`))).rejects.toMatchObject({ code: "ENOENT" });
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
    await expect(manager.createPreview("repo", { label: "Metadata", url: "http://169.254.169.254/latest/meta-data" })).resolves.toMatchObject({
      ok: false,
      status: 400,
      error: { code: "invalid_preview_url" },
    });
    await expect(manager.createPreview("repo", { label: "Down", url: "https://localhost:3000" })).resolves.toMatchObject({
      ok: true,
      preview: { lastStatus: "failed" },
    });
    expect(probeUrl).toHaveBeenCalledTimes(1);
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
});
