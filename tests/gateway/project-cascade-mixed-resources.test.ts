import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createAgentSessionManager } from "../../packages/gateway/src/domains/sessions/agent-session-manager.js";
import { createProjectManager } from "../../packages/gateway/src/domains/workspace/project-manager.js";
import { createWorktreeManager } from "../../packages/gateway/src/domains/git/worktree-manager.js";
import { createReviewStore } from "../../packages/gateway/src/domains/review/review-store.js";
import { createReviewLoopRecord } from "../../packages/gateway/src/domains/review/review-loop.js";
import { createWorkspaceRoutes } from "../../packages/gateway/src/domains/workspace/workspace-routes.js";

it.each(["none", "background", "terminal"])("deletes mixed project resources, with retry after %s failure", async (failure) => {
  const homePath = await mkdtemp(join(tmpdir(), "matrix-mixed-cascade-"));
  let unavailable = failure;
  const terminal = {
    terminateTab: vi.fn(async () => { if (unavailable === "terminal") throw new Error("Terminal unavailable"); }),
    listWorkspaces: vi.fn(async () => []), deleteTab: vi.fn(), deleteWorkspace: vi.fn(),
  };
  const background = {
    start: vi.fn(), isRunning: vi.fn(),
    stop: vi.fn(async () => { if (unavailable === "background") throw new Error("Background unavailable"); }),
  };
  const legacy = { deleteSession: vi.fn(async () => undefined) };
  const worktrees = createWorktreeManager({ homePath, runCommand: vi.fn(async () => ({ stdout: "", stderr: "" })) });
  const sessions = createAgentSessionManager({ homePath, terminalRuntime: terminal as never,
    backgroundRuntime: background, legacyZellij: legacy, worktreeManager: worktrees,
    agentLauncher: { buildLaunch: vi.fn() }, startupRetryDelaysMs: [],
  });
  try {
    const projects = createProjectManager({ homePath });
    const ownerScope = { type: "user" as const, id: "user_a" };
    await mkdir(join(homePath, "source"), { recursive: true });
    await writeFile(join(homePath, "source/source.txt"), "original source");
    expect((await projects.createProject({ mode: "folder", name: "Mixed", slug: "mixed", path: "source", ownerScope })).ok).toBe(true);
    for (const dir of ["tasks", "previews"]) await mkdir(join(homePath, "projects/mixed", dir), { recursive: true });
    const legacyTask = join(homePath, "projects/mixed/tasks/task_owned.json");
    const legacyPreview = join(homePath, "projects/mixed/previews/prev_owned.json");
    const timestamps = { createdAt: "2026-08-01T00:00:00Z", updatedAt: "2026-08-01T00:00:00Z" };
    await writeFile(legacyTask, JSON.stringify({ id: "task_owned", projectSlug: "mixed", title: "Old task",
      status: "running", priority: "normal", order: 0, previewIds: ["prev_owned"], ...timestamps }));
    await writeFile(legacyPreview, JSON.stringify({ id: "prev_owned", projectSlug: "mixed", label: "Preview",
      url: "https://example.com", lastStatus: "unknown", displayPreference: "panel", ...timestamps }));
    const worktreeId = "wt_123456789abc";
    const checkout = join(homePath, "worktrees/mixed", worktreeId);
    const metadata = join(homePath, "system/projects/mixed/worktrees", worktreeId);
    await mkdir(checkout, { recursive: true });
    await mkdir(metadata, { recursive: true });
    await writeFile(join(metadata, "worktree.json"), JSON.stringify({ id: worktreeId, projectSlug: "mixed", path: checkout,
      sourceBranch: "main", currentBranch: "feature", dirtyState: "clean", createdAt: "2026-08-01T00:00:00Z" }));
    expect((await worktrees.acquireLease({ projectSlug: "mixed", worktreeId, holderType: "session", holderId: "sess_modern" })).ok).toBe(true);
    const variants = [
      { id: "sess_modern", worktreeId, runtime: { type: "zellij", status: "waiting" },
        terminalRef: { workspaceId: "tws_00000000000000000000000000000001", tabId: "tt_00000000000000000000000000000001" } },
      { id: "sess_background", runtime: { type: "background", status: "running" }, backgroundRef: { id: "bg_00000000000000000000000000000001" } },
      { id: "sess_legacy", runtime: { type: "zellij", status: "degraded", zellijSession: "matrix-rt_old" } },
      { id: "sess_exited", runtime: { type: "zellij", status: "exited" } },
      { id: "sess_other_project", projectSlug: "other", runtime: { type: "zellij", status: "running" } },
      { id: "sess_other_owner", ownerId: "user_b", runtime: { type: "zellij", status: "running" } },
    ];
    await mkdir(join(homePath, "system/sessions"), { recursive: true });
    for (const v of variants) await writeFile(join(homePath, "system/sessions", `${v.id}.json`), JSON.stringify({
      kind: "agent", projectSlug: "mixed", ownerId: "user_a", transcriptPath: "unused", attachedClients: 0,
      writeMode: "closed", startedAt: "2026-08-01T00:00:00Z", lastActivityAt: "2026-08-01T00:00:00Z", ...v,
    }));
    const reviews = createReviewStore({ homePath });
    await reviews.saveReview(createReviewLoopRecord({ id: "rev_mixed", projectSlug: "mixed", worktreeId,
      pr: 1, reviewer: "claude", implementer: "codex", maxRounds: 2, convergenceGate: "findings_only", verificationCommands: [] }));
    const app = createWorkspaceRoutes({ homePath, projectManager: projects, worktreeManager: worktrees,
      agentSessionManager: sessions, terminalRuntime: terminal as never, reviewStore: reviews, getOwnerScope: () => ownerScope });
    const remove = () => app.request("/api/projects/mixed/actions", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "delete", confirmation: "Mixed", confirmTerminate: true }) });
    if (failure !== "none") {
      expect((await remove()).status).toBe(500);
      await expect(stat(checkout)).resolves.toBeDefined();
      await expect(stat(join(homePath, "system/sessions/sess_background.json"))).resolves.toBeDefined();
      unavailable = "none";
    }
    expect((await remove()).status).toBe(200);
    for (const v of variants.slice(0, 4)) await expect(stat(join(homePath, "system/sessions", `${v.id}.json`))).rejects.toMatchObject({ code: "ENOENT" });
    for (const v of variants.slice(4)) await expect(stat(join(homePath, "system/sessions", `${v.id}.json`))).resolves.toBeDefined();
    await expect(stat(checkout)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(homePath, "system/reviews/rev_mixed.json"))).rejects.toMatchObject({ code: "ENOENT" });
    for (const path of [legacyTask, legacyPreview]) await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(homePath, "source/source.txt"), "utf8")).toBe("original source");
  } finally { sessions.shutdown(); await rm(homePath, { recursive: true, force: true }); }
});
