import { describe, expect, it, vi } from "vitest";
import {
  openExistingProject,
  submitExistingFolder,
  type AddProjectSubmitContext,
} from "../../desktop/src/renderer/src/features/board/add-project-submit";
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
