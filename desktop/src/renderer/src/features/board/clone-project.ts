// Clone request for the add-project dialog. A git clone can legitimately run
// for minutes, so this call uses the authenticated ApiClient with an explicit
// operation timeout. Keeping the request in ApiClient preserves its 401
// session-expiry callback and safe error-code parsing.
import type { ApiClient } from "../../lib/api";
import { AppError } from "../../lib/errors";

// Gateway CLONE_TIMEOUT_MS is 5 minutes; the client waits slightly longer so
// the server's own timeout error wins the race.
export const CLONE_REQUEST_TIMEOUT_MS = 310_000;

export interface ClonedProject {
  slug: string;
  name: string;
}

type CloneResult = { ok: true; project: ClonedProject } | { ok: false; message: string };

function cloneErrorMessage(code: string | null): string {
  switch (code) {
    case "slug_conflict":
      return "A project with that name already exists. Choose a different folder name.";
    case "github_auth_required":
      return "GitHub isn't connected on this computer. Sign in from the terminal, then try again.";
    case "invalid_repository_url":
      return "That doesn't look like a GitHub repository URL.";
    case "invalid_slug":
    case "invalid_branch":
    case "invalid_request":
      return "Check the folder name and branch, then try again.";
    default:
      return "Couldn't clone the repository. Check the URL and try again.";
  }
}

export async function cloneProject(options: {
  api: ApiClient;
  url: string;
  name?: string;
  displayName?: string;
  description?: string;
  branch?: string;
  clientRequestId: string;
}): Promise<CloneResult> {
  try {
    const body = await options.api.post<{ project?: { slug?: unknown; name?: unknown } }>(
      "/api/projects/clone",
      {
        url: options.url,
        ...(options.name ? { name: options.name } : {}),
        ...(options.displayName ? { displayName: options.displayName } : {}),
        ...(options.description ? { description: options.description } : {}),
        ...(options.branch ? { branch: options.branch } : {}),
        clientRequestId: options.clientRequestId,
      },
      { timeoutMs: CLONE_REQUEST_TIMEOUT_MS },
    );
    const slug = typeof body.project?.slug === "string" ? body.project.slug : null;
    const name = typeof body.project?.name === "string" ? body.project.name : null;
    if (!slug) {
      console.warn("[add-project] clone response missing project slug");
      return { ok: false, message: "Couldn't create the project. Try again." };
    }
    return { ok: true, project: { slug, name: name ?? slug } };
  } catch (err: unknown) {
    const kind = err instanceof AppError ? err.category : err instanceof Error ? err.name : "Unknown error";
    console.warn("[add-project] clone request failed:", kind);
    if (err instanceof AppError) {
      if (err.category === "unauthorized") {
        return { ok: false, message: "Your session has expired. Please sign in again." };
      }
      if (err.detail) return { ok: false, message: cloneErrorMessage(err.detail) };
      if (err.category === "offline" || err.category === "timeout") {
        return { ok: false, message: "Couldn't reach your Matrix computer. Check the connection and try again." };
      }
    }
    return { ok: false, message: "Couldn't clone the repository. Check the URL and try again." };
  }
}
