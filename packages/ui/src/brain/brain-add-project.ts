/**
 * Adding a project from the Company Brain: clone a GitHub link (POST /api/projects/clone) or add a folder already on
 * the computer (POST /api/projects, folder mode). The brain then connects and syncs it through its own client.
 */
import { BRAIN_READ_TIMEOUT_MS, brainProjectOption, type BrainHttpTransport } from "./brain-client.js";
import type { BrainProjectOption } from "./brain-types.js";

/** The gateway gives a clone 5 minutes; the client waits a little longer so the gateway's answer wins. */
export const BRAIN_CLONE_TIMEOUT_MS = 310_000;
/** Folders one picker list shows. */
export const BRAIN_FOLDERS_MAX = 500;
/** After a clone request was cut short, the project list is read again this often, this many times (5 minutes). */
export const BRAIN_CLONE_WAIT_MS = 5_000;
export const BRAIN_CLONE_WAIT_TRIES = 60;

/** What the Add project panel needs from a renderer; built over the same transport as the brain client. */
export interface BrainProjectAdder {
  clone(url: string, clientRequestId: string): Promise<BrainProjectOption>;
  addFolder(path: string, name: string, clientRequestId: string): Promise<BrainProjectOption>;
  /**
   * Whether the project's folder is a git repository (GET /api/projects/:slug/code-metadata); null when the answer
   * does not say.
   */
  isGitRepository(slug: string): Promise<boolean | null>;
  /** The folder names inside `path` (relative to the Matrix home; "" is the home). */
  folders(path: string): Promise<readonly string[]>;
}

function projectFrom(value: unknown): BrainProjectOption {
  const project = brainProjectOption(typeof value === "object" && value !== null
    ? (value as { project?: unknown }).project : undefined);
  if (project === null) throw new Error("project answer not readable");
  return project;
}

export function createBrainProjectAdder(client: BrainHttpTransport): BrainProjectAdder {
  return {
    clone: async (url, clientRequestId) => projectFrom(
      await client.post("/api/projects/clone", { url, clientRequestId }, { timeoutMs: BRAIN_CLONE_TIMEOUT_MS }),
    ),
    addFolder: async (path, name, clientRequestId) => projectFrom(await client.post("/api/projects", {
      mode: "folder", path, name, clientRequestId,
    }, { timeoutMs: BRAIN_READ_TIMEOUT_MS })),
    isGitRepository: async (slug) => {
      const value = await client.get<unknown>(`/api/projects/${encodeURIComponent(slug)}/code-metadata`,
        { timeoutMs: BRAIN_READ_TIMEOUT_MS });
      const answer = typeof value === "object" && value !== null
        ? (value as { isGitRepository?: unknown }).isGitRepository : undefined;
      return typeof answer === "boolean" ? answer : null;
    },
    folders: async (path) => {
      const value = await client.get<unknown>(`/api/files/list?path=${encodeURIComponent(path)}`,
        { timeoutMs: BRAIN_READ_TIMEOUT_MS });
      const entries = typeof value === "object" && value !== null ? (value as { entries?: unknown }).entries : undefined;
      if (!Array.isArray(entries)) return [];
      return entries.flatMap((entry: unknown) => {
        if (typeof entry !== "object" || entry === null) return [];
        const { name, type } = entry as Record<string, unknown>;
        return type === "directory" && typeof name === "string" && name !== "" && !name.includes("/") ? [name] : [];
      }).slice(0, BRAIN_FOLDERS_MAX);
    },
  };
}

const GITHUB_LINK = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/;

/** A pasted GitHub link as the clone route takes it (https://github.com/owner/repo), or null when it is not one. */
export function brainRepositoryLink(text: string): string | null {
  let value = text.trim();
  if (/^(www\.)?github\.com\//.test(value)) value = `https://${value}`;
  value = value.replace(/^http:\/\//, "https://").replace(/^https:\/\/www\.github\.com\//, "https://github.com/");
  const match = GITHUB_LINK.exec(value);
  const owner = match?.[1];
  const repo = match?.[2];
  if (!owner || !repo || owner.startsWith(".") || repo.startsWith(".")) return null;
  return `https://github.com/${owner}/${repo}`;
}

/** The project slug the gateway makes from a name (its slugify); "" when nothing is left. */
export function brainProjectSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63);
}

/** The repository name of a link brainRepositoryLink accepted. */
export function brainRepositoryName(link: string): string {
  return link.split("/").at(-1) ?? "";
}

/** The last segment of a folder path. */
export function brainFolderName(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? "";
}

export function brainAddRequestId(): string {
  return `req_${globalThis.crypto.randomUUID().replaceAll("-", "")}`;
}

/** The category and gateway code of a failed transport call, read by shape. */
function failure(error: unknown): { readonly category: string; readonly code: string } {
  const { category, detail } = (error ?? {}) as { readonly category?: unknown; readonly detail?: unknown };
  return {
    category: typeof category === "string" ? category : "",
    code: typeof detail === "string" ? detail : "",
  };
}

/** A clone or folder add that failed because a project of that name is already there. */
export function brainProjectExists(error: unknown): boolean {
  return failure(error).code === "slug_conflict";
}

/** A clone cut short on its way back (too slow, or a proxy ending it) may still be running in the gateway. */
export function brainCloneMayContinue(error: unknown): boolean {
  const { category, code } = failure(error);
  return category === "timeout" || (category === "server" && code === "");
}

const ADD_ERROR_TEXT: Readonly<Record<string, string>> = {
  github_auth_required: "GitHub is not signed in on this computer. Run gh auth login in Terminal, then try again.",
  clone_failed: "Could not clone that repository. Check the link and that this computer can open it.",
  invalid_repository_url: "That is not a GitHub repository link.",
  invalid_project_path: "That folder cannot be added. Pick another one.",
  invalid_project_name: "That folder cannot be added. Pick another one.",
  invalid_slug: "That name cannot be used for a project. Pick another folder.",
  slug_conflict: "A project with that name already exists.",
};

/** Plain words for a failed clone or folder add; never the server's own message. */
export function brainAddErrorText(error: unknown): string {
  const { category, code } = failure(error);
  if (Object.hasOwn(ADD_ERROR_TEXT, code)) return ADD_ERROR_TEXT[code]!;
  if (category === "unauthorized") return "Your session has ended. Sign in again.";
  if (category === "offline") return "Can't reach Matrix OS. Check your connection.";
  if (category === "notFound") return "That folder is gone. Pick another one.";
  return "Could not add the project. Try again.";
}
