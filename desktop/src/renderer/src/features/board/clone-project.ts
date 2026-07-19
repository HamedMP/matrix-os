// Clone request for the add-project dialog. The shared ApiClient caps calls
// at 10s, but a git clone can legitimately run for minutes (the gateway
// bounds it at 5 minutes), so this one POST uses a raw fetch with a matching
// timeout. Auth still rides the Authorization header injected by the trusted
// core at the network layer (desktop/src/main/auth/header-injection.ts),
// exactly like the ApiClient. Server error bodies are read only for their
// safe snake_case code and mapped to generic copy — raw git output never
// reaches the UI.
import { buildGatewayUrl } from "../../lib/api";

// Gateway CLONE_TIMEOUT_MS is 5 minutes; the client waits slightly longer so
// the server's own timeout error wins the race.
export const CLONE_REQUEST_TIMEOUT_MS = 310_000;

export interface ClonedProject {
  slug: string;
  name: string;
}

type CloneResult = { ok: true; project: ClonedProject } | { ok: false; message: string };

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

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
  baseUrl: string;
  runtimeSlot: string;
  url: string;
  name?: string;
  branch?: string;
  fetchFn?: FetchFn;
}): Promise<CloneResult> {
  const fetchFn: FetchFn = options.fetchFn ?? ((input, init) => fetch(input, init));
  let response: Response;
  try {
    response = await fetchFn(buildGatewayUrl(options.baseUrl, "/api/projects/clone", options.runtimeSlot), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: options.url,
        ...(options.name ? { name: options.name } : {}),
        ...(options.branch ? { branch: options.branch } : {}),
      }),
      signal: AbortSignal.timeout(CLONE_REQUEST_TIMEOUT_MS),
    });
  } catch (err: unknown) {
    console.warn("[add-project] clone request failed:", err instanceof Error ? err.message : String(err));
    return { ok: false, message: "Couldn't reach your Matrix computer. Check the connection and try again." };
  }
  if (response.ok) {
    try {
      const body = (await response.json()) as { project?: { slug?: unknown; name?: unknown } };
      const slug = typeof body.project?.slug === "string" ? body.project.slug : null;
      const name = typeof body.project?.name === "string" ? body.project.name : null;
      if (!slug) {
        console.warn("[add-project] clone response missing project slug");
        return { ok: false, message: "Couldn't create the project. Try again." };
      }
      return { ok: true, project: { slug, name: name ?? slug } };
    } catch (err: unknown) {
      console.warn("[add-project] clone response unreadable:", err instanceof Error ? err.message : String(err));
      return { ok: false, message: "Couldn't create the project. Try again." };
    }
  }
  let code: string | null = null;
  try {
    const body = (await response.json()) as { error?: { code?: unknown } };
    code = typeof body.error?.code === "string" ? body.error.code : null;
  } catch (err: unknown) {
    // Non-JSON error body — fall through to the generic message.
    console.warn("[add-project] clone error body unreadable:", err instanceof Error ? err.message : String(err));
  }
  return { ok: false, message: cloneErrorMessage(code) };
}
