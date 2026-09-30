import { describe, expect, it, vi } from "vitest";
import {
  openExistingProject,
  submitExistingFolder,
  type AddProjectSubmitContext,
} from "../../desktop/src/renderer/src/features/board/add-project-submit";
import { cloneProject } from "../../desktop/src/renderer/src/features/board/clone-project";
import type { Project } from "../../desktop/src/renderer/src/stores/board";

const existingProject: Project = {
  id: "proj_existing",
  slug: "existing",
  name: "Existing",
  kind: "folder",
  localPath: "projects/existing",
};

function context(overrides: Partial<AddProjectSubmitContext> = {}): AddProjectSubmitContext {
  return {
    api: {} as AddProjectSubmitContext["api"],
    runtimeSlot: "primary",
    getProjects: () => [existingProject],
    createProject: vi.fn(async () => null),
    selectProject: vi.fn(async () => undefined),
    loadProjects: vi.fn(async () => true),
    openTab: vi.fn(),
    isCurrent: () => true,
    setError: vi.fn(),
    close: vi.fn(),
    onCreatedProject: vi.fn(),
    ...overrides,
  };
}

describe("add-project sharing handoff", () => {
  it("preserves the canonical project ID returned by clone creation", async () => {
    const api = {
      post: vi.fn(async () => ({
        project: { id: "proj_clone", slug: "clone", name: "Clone", kind: "github" },
      })),
    } as unknown as AddProjectSubmitContext["api"];

    const result = await cloneProject({
      api,
      url: "https://github.com/matrix-os/clone",
      clientRequestId: "req_clone",
    });

    expect(result).toMatchObject({ ok: true, project: { id: "proj_clone", slug: "clone" } });
  });

  it("does not treat opening an already connected project as project creation", async () => {
    const ctx = context();

    await openExistingProject(ctx, existingProject.slug);

    expect(ctx.onCreatedProject).not.toHaveBeenCalled();
  });

  it("hands a newly connected folder project to the opted-in sharing flow", async () => {
    const created: Project = {
      id: "proj_created",
      slug: "created",
      name: "Created",
      kind: "folder",
      localPath: "projects/created",
    };
    const ctx = context({
      getProjects: () => [],
      createProject: vi.fn(async () => created),
    });

    await submitExistingFolder(ctx, { name: created.name, path: created.localPath! });

    expect(ctx.onCreatedProject).toHaveBeenCalledWith(created);
  });
});
