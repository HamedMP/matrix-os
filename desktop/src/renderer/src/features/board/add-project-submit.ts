// Submit orchestration for the add-project dialog: one function per mode.
// Every helper re-checks the dialog generation (isCurrent) after each await
// so a closed dialog or a superseded submit never mutates state, and all
// client-visible errors are generic copy.
import type { ApiClient } from "../../lib/api";
import { AppError, toUserMessage } from "../../lib/errors";
import type { Project } from "../../stores/board";
import { cloneProject } from "./clone-project";
import { slugifyProjectName } from "./add-project-model";

export interface AddProjectSubmitContext {
  api: ApiClient;
  runtimeSlot: string;
  createProject: (
    api: ApiClient,
    input: { name: string; mode: "scratch" | "github" | "folder"; url?: string; path?: string },
  ) => Promise<Project | null>;
  selectProject: (api: ApiClient, slug: string) => Promise<void>;
  loadProjects: (api: ApiClient) => Promise<boolean>;
  openTab: (tab: { kind: "project"; projectSlug: string; title: string }) => void;
  // False once the dialog closed or a newer submit superseded this one.
  isCurrent: () => boolean;
  setError: (message: string) => void;
  close: () => void;
}

// Shared success path for every mode: make the new project active and open
// its project tab.
async function finish(ctx: AddProjectSubmitContext, project: { slug: string; name: string }): Promise<void> {
  await ctx.selectProject(ctx.api, project.slug);
  if (!ctx.isCurrent()) return;
  ctx.close();
  ctx.openTab({ kind: "project", projectSlug: project.slug, title: project.name || project.slug });
}

export async function submitExistingFolder(
  ctx: AddProjectSubmitContext,
  input: { name: string; path: string },
): Promise<void> {
  const project = await ctx.createProject(ctx.api, { name: input.name, mode: "folder", path: input.path });
  if (!ctx.isCurrent()) return;
  if (!project) {
    ctx.setError("Couldn't connect that folder. Check that it exists on this computer.");
    return;
  }
  await finish(ctx, project);
}

export async function submitClone(
  ctx: AddProjectSubmitContext,
  input: { url: string; name: string; branch?: string },
): Promise<void> {
  const result = await cloneProject({
    baseUrl: ctx.api.baseUrl,
    runtimeSlot: ctx.runtimeSlot,
    url: input.url,
    name: input.name,
    branch: input.branch,
  });
  if (!ctx.isCurrent()) return;
  if (!result.ok) {
    ctx.setError(result.message);
    return;
  }
  // The board store only refreshes on its own create path, so pull the new
  // clone into the sidebar list explicitly.
  await ctx.loadProjects(ctx.api);
  if (!ctx.isCurrent()) return;
  await finish(ctx, result.project);
}

export async function submitNewFolder(
  ctx: AddProjectSubmitContext,
  input: { name: string; parentPath: string },
): Promise<void> {
  if (!input.parentPath) {
    const project = await ctx.createProject(ctx.api, { name: input.name, mode: "scratch" });
    if (!ctx.isCurrent()) return;
    if (!project) {
      ctx.setError("Couldn't create the project. Check the name.");
      return;
    }
    await finish(ctx, project);
    return;
  }
  // Custom parent: create the folder exclusively via the mkdir route, then
  // bind it as a folder project. A bind failure leaves the empty folder
  // behind; the user can connect it with "Existing folder".
  let createdPath: string;
  try {
    const created = await ctx.api.post<{ path?: unknown }>("/api/projects/mkdir", {
      name: slugifyProjectName(input.name),
      parent: input.parentPath,
    });
    if (typeof created.path !== "string" || created.path.length === 0) {
      if (ctx.isCurrent()) ctx.setError("Couldn't create the folder. Try again.");
      return;
    }
    createdPath = created.path;
  } catch (err: unknown) {
    if (!ctx.isCurrent()) return;
    ctx.setError(
      err instanceof AppError && err.detail === "folder_conflict"
        ? "A folder with that name already exists there."
        : toUserMessage(err),
    );
    return;
  }
  const project = await ctx.createProject(ctx.api, { name: input.name, mode: "folder", path: createdPath });
  if (!ctx.isCurrent()) return;
  if (!project) {
    ctx.setError("The folder was created but couldn't be connected. Add it with “Existing folder”.");
    return;
  }
  await finish(ctx, project);
}
