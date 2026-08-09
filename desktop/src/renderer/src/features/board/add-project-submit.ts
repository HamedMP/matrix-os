// Submit orchestration for the add-project dialog: one function per mode.
// Every helper re-checks the dialog generation (isCurrent) after each await
// so a closed dialog or a superseded submit never mutates state. User-facing
// errors use bounded app-owned copy rather than raw upstream messages.
import type { ApiClient } from "../../lib/api";
import { AppError, toUserMessage } from "../../lib/errors";
import type { Project } from "../../stores/board";
import { cloneProject } from "./clone-project";
import { slugifyProjectName } from "./add-project-model";

export interface AddProjectSubmitContext {
  api: ApiClient;
  runtimeSlot: string;
  getProjects: () => Project[];
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

function projectPathMatches(localPath: string | undefined, selectedPath: string): boolean {
  if (!localPath) return false;
  const normalizedLocalPath = localPath.replaceAll("\\", "/").replace(/\/+$/, "");
  const normalizedSelectedPath = selectedPath
    .replaceAll("\\", "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+$/, "");
  return normalizedSelectedPath.length > 0
    && (normalizedLocalPath === normalizedSelectedPath
      || normalizedLocalPath.endsWith(`/${normalizedSelectedPath}`));
}

async function handleExistingFolderProject(
  ctx: AddProjectSubmitContext,
  input: { name: string; path: string },
): Promise<boolean> {
  const projects = ctx.getProjects();
  // Folder identity is stronger than the editable display name. In particular,
  // managed checkouts end in /repo, so deriving the form name from the final
  // path segment cannot recover the owning project slug.
  const projectAtPath = projects.find((project) => projectPathMatches(project.localPath, input.path));
  if (projectAtPath) {
    await finish(ctx, projectAtPath);
    return true;
  }
  const existingProject = projects.find(
    (project) => project.slug === slugifyProjectName(input.name),
  );
  if (!existingProject) return false;
  ctx.setError(`A project named “${existingProject.name}” already exists. Choose another name.`);
  return true;
}

// Shared success path for every mode: make the new project active and open
// its project tab.
async function finish(ctx: AddProjectSubmitContext, project: { slug: string; name: string }): Promise<void> {
  await ctx.selectProject(ctx.api, project.slug);
  if (!ctx.isCurrent()) return;
  ctx.close();
  ctx.openTab({ kind: "project", projectSlug: project.slug, title: project.name || project.slug });
}

export async function openExistingProject(ctx: AddProjectSubmitContext, slug: string): Promise<void> {
  const project = ctx.getProjects().find((candidate) => candidate.slug === slug);
  if (!project) {
    ctx.setError("That project is no longer available. Refresh and try again.");
    return;
  }
  await finish(ctx, project);
}

export async function submitExistingFolder(
  ctx: AddProjectSubmitContext,
  input: { name: string; path: string },
): Promise<void> {
  if (await handleExistingFolderProject(ctx, input)) return;
  const project = await ctx.createProject(ctx.api, { name: input.name, mode: "folder", path: input.path });
  if (!ctx.isCurrent()) return;
  if (!project) {
    await ctx.loadProjects(ctx.api);
    if (!ctx.isCurrent()) return;
    if (await handleExistingFolderProject(ctx, input)) return;
    ctx.setError("Couldn't connect that folder. Check that it exists on this computer.");
    return;
  }
  await finish(ctx, project);
}

export async function submitClone(
  ctx: AddProjectSubmitContext,
  input: { url: string; name: string; branch?: string; clientRequestId: string },
): Promise<void> {
  const result = await cloneProject({
    api: ctx.api,
    url: input.url,
    name: input.name,
    branch: input.branch,
    clientRequestId: input.clientRequestId,
  });
  if (!ctx.isCurrent()) return;
  if (!result.ok) {
    ctx.setError(result.message);
    return;
  }
  // The board store only refreshes on its own create path, so pull the new
  // clone into the sidebar list explicitly.
  const refreshed = await ctx.loadProjects(ctx.api);
  if (!ctx.isCurrent()) return;
  if (!refreshed) {
    ctx.setError("The project was created, but the project list could not be refreshed. Try again.");
    return;
  }
  await finish(ctx, result.project);
}

export async function submitNewFolder(
  ctx: AddProjectSubmitContext,
  input: { name: string; parentPath: string; clientRequestId: string },
): Promise<void> {
  const parentPath = input.parentPath.trim().replace(/^\.\/+/, "").replace(/\/+$/, "");
  // Selecting the visible Projects directory is semantically identical to the
  // default location. Use the manager-owned scratch path instead of mkdir +
  // folder bind, which would pre-create the registry slot and then conflict.
  if (!parentPath || parentPath === "projects") {
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
    const body = {
      name: slugifyProjectName(input.name),
      parent: parentPath,
      clientRequestId: input.clientRequestId,
    };
    let created: { path?: unknown };
    try {
      created = await ctx.api.post<{ path?: unknown }>(
        "/api/projects/mkdir",
        body,
        { timeoutMs: 30_000 },
      );
    } catch (err: unknown) {
      if (!(err instanceof AppError) || err.category !== "timeout") throw err;
      created = await ctx.api.post<{ path?: unknown }>(
        "/api/projects/mkdir",
        body,
        { timeoutMs: 310_000 },
      );
    }
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
