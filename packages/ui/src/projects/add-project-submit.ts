// Submit orchestration for the add-project dialog: one function per mode,
// shared by Electron Desktop and the web OS views. Each OS view injects its
// own transport and navigation. Every helper re-checks isCurrent after each
// await so a closed dialog or a superseded submit never mutates state.
// User-facing errors use bounded app-owned copy, never raw upstream messages.
import { slugifyProjectName, type AddProjectRecord } from "./add-project-model.js";

export type AddProjectOutcome<T> = { ok: true; value: T } | { ok: false; message: string };

export interface AddProjectSubmitContext<P extends AddProjectRecord = AddProjectRecord> {
  getProjects(): readonly P[];
  /** Resolves null on any failure; the caller shows mode-specific copy. */
  createProject(input: { name: string; description?: string; mode: "scratch" | "folder"; path?: string }): Promise<P | null>;
  cloneProject(input: { url: string; name: string; displayName: string; description?: string; branch?: string; clientRequestId: string }): Promise<AddProjectOutcome<P>>;
  /** Exclusively creates `parent/name`; resolves the created folder path. */
  createFolder(input: { name: string; parent: string; clientRequestId: string }): Promise<AddProjectOutcome<string>>;
  loadProjects(): Promise<boolean>;
  selectProject(project: P): Promise<void>;
  /** Opens the project's page after the dialog closes. */
  openProject(project: P): void;
  // False once the dialog closed or a newer submit superseded this one.
  isCurrent(): boolean;
  setError(message: string): void;
  close(): void;
  onCreatedProject?(project: P): void;
  onProjectReady?(project: P): Promise<void | (() => void)>;
}

const CLONE_ERROR_COPY: Record<string, string> = {
  slug_conflict: "A project with that name already exists. Choose a different folder name.",
  github_auth_required: "GitHub isn't connected on this computer. Sign in from the terminal, then try again.",
  github_ssh_setup_required: "Open Settings → Connect Apps → GitHub Developer to finish SSH setup, then try again.",
  invalid_repository_url: "That doesn't look like a GitHub repository URL.",
  invalid_slug: "Check the folder name and branch, then try again.",
  invalid_branch: "Check the folder name and branch, then try again.",
  invalid_request: "Check the folder name and branch, then try again.",
};
export const CLONE_FAILED_COPY = "Couldn't clone the repository. Check the URL and try again.";
export const FOLDER_CONFLICT_COPY = "A folder with that name already exists there.";
export const SESSION_EXPIRED_COPY = "Your session has expired. Please sign in again.";
export const COMPUTER_UNREACHABLE_COPY = "Couldn't reach your Matrix computer. Check the connection and try again.";

/** Allowlisted copy for a gateway clone error code. */
export function cloneErrorMessage(code: string | null | undefined): string {
  return (code && Object.hasOwn(CLONE_ERROR_COPY, code) ? CLONE_ERROR_COPY[code] : undefined) ?? CLONE_FAILED_COPY;
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

async function handleExistingFolderProject<P extends AddProjectRecord>(
  ctx: AddProjectSubmitContext<P>,
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
  const existingProject = projects.find((project) => project.slug === slugifyProjectName(input.name));
  if (!existingProject) return false;
  ctx.setError(`A project named “${existingProject.name}” already exists. Choose another name.`);
  return true;
}

// Shared success path for every mode: make the new project active and open its page.
async function finish<P extends AddProjectRecord>(
  ctx: AddProjectSubmitContext<P>,
  project: P,
  options: { created?: boolean } = {},
): Promise<void> {
  await ctx.selectProject(project);
  if (!ctx.isCurrent()) return;
  const afterOpened = await ctx.onProjectReady?.(project);
  if (!ctx.isCurrent()) return;
  ctx.close();
  ctx.openProject(project);
  afterOpened?.();
  if (options.created) ctx.onCreatedProject?.(project);
}

export async function openExistingProject<P extends AddProjectRecord>(ctx: AddProjectSubmitContext<P>, slug: string): Promise<void> {
  const project = ctx.getProjects().find((candidate) => candidate.slug === slug);
  if (!project) {
    ctx.setError("That project is no longer available. Refresh and try again.");
    return;
  }
  await finish(ctx, project);
}

export async function submitExistingFolder<P extends AddProjectRecord>(
  ctx: AddProjectSubmitContext<P>,
  input: { name: string; description?: string; path: string },
): Promise<void> {
  if (await handleExistingFolderProject(ctx, input)) return;
  const project = await ctx.createProject({ name: input.name, description: input.description, mode: "folder", path: input.path });
  if (!ctx.isCurrent()) return;
  if (!project) {
    await ctx.loadProjects();
    if (!ctx.isCurrent()) return;
    if (await handleExistingFolderProject(ctx, input)) return;
    ctx.setError("Couldn't connect that folder. Check that it exists on this computer.");
    return;
  }
  await finish(ctx, project, { created: true });
}

export async function submitClone<P extends AddProjectRecord>(
  ctx: AddProjectSubmitContext<P>,
  input: { url: string; name: string; displayName: string; description?: string; branch?: string; clientRequestId: string },
): Promise<void> {
  const result = await ctx.cloneProject(input);
  if (!ctx.isCurrent()) return;
  if (!result.ok) {
    ctx.setError(result.message);
    return;
  }
  // Pull the new clone into the project list explicitly before opening it.
  const refreshed = await ctx.loadProjects();
  if (!ctx.isCurrent()) return;
  if (!refreshed) {
    ctx.setError("The project was created, but the project list could not be refreshed. Try again.");
    return;
  }
  const project = ctx.getProjects().find((candidate) => candidate.slug === result.value.slug) ?? result.value;
  if (ctx.onCreatedProject && !project.id) {
    ctx.setError("The project was created, but sharing could not be prepared. Refresh and share it from Chats.");
    return;
  }
  await finish(ctx, project, { created: true });
}

export async function submitNewFolder<P extends AddProjectRecord>(
  ctx: AddProjectSubmitContext<P>,
  input: { name: string; description?: string; parentPath: string; clientRequestId: string },
): Promise<void> {
  const parentPath = input.parentPath.trim().replace(/^\.\/+/, "").replace(/\/+$/, "");
  // Selecting the visible Projects directory is semantically identical to the
  // default location. Use the manager-owned scratch path instead of mkdir +
  // folder bind, which would pre-create the registry slot and then conflict.
  if (!parentPath || parentPath === "projects") {
    const project = await ctx.createProject({ name: input.name, description: input.description, mode: "scratch" });
    if (!ctx.isCurrent()) return;
    if (!project) {
      ctx.setError("Couldn't create the project. Check the name.");
      return;
    }
    await finish(ctx, project, { created: true });
    return;
  }
  // Custom parent: create the folder exclusively, then bind it as a folder
  // project. A bind failure leaves the empty folder behind; the user can
  // connect it with "Existing folder".
  const created = await ctx.createFolder({
    name: slugifyProjectName(input.name),
    parent: parentPath,
    clientRequestId: input.clientRequestId,
  });
  if (!ctx.isCurrent()) return;
  if (!created.ok) {
    ctx.setError(created.message);
    return;
  }
  const project = await ctx.createProject({ name: input.name, description: input.description, mode: "folder", path: created.value });
  if (!ctx.isCurrent()) return;
  if (!project) {
    ctx.setError("The folder was created but couldn't be connected. Add it with “Existing folder”.");
    return;
  }
  await finish(ctx, project, { created: true });
}
