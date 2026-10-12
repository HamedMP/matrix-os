import { z } from "zod/v4";

import { fetchAuthenticatedAnswer, gatewayRequestUrl, type RequestAnswer } from "@/lib/requests/answers";
import { buildGatewayRequestUrl, fetchAuthenticatedJson } from "@/lib/requests/http";

const PROJECTS_UNAVAILABLE_ERROR = "Projects unavailable. Try again.";
const PROJECT_LIST_LIMIT = 200;
const PROJECT_NAME_MAX_LENGTH = 128;
// PROJECT_SLUG_REGEX in packages/gateway/src/project-registry.ts.
const PROJECT_SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
// CreateProjectSchema.clientRequestId in packages/gateway/src/workspace-routes.ts.
const CREATE_REQUEST_ID = /^req_[A-Za-z0-9_-]{1,128}$/;

// Matches ProjectConfig (packages/gateway/src/project-manager.ts) -- an
// internal server interface, not a shared @matrix-os/contracts schema, so
// validated here against only the fields the picker actually needs.
const ProjectSummarySchema = z.object({
  id: z.string().min(1).max(160),
  slug: z.string().min(1).max(160),
  name: z.string().min(1).max(240),
  kind: z.enum(["scratch", "github", "folder"]),
  updatedAt: z.string().optional(),
  archivedAt: z.string().optional(),
  github: z.object({
    owner: z.string(),
    repo: z.string(),
  }).loose().optional(),
});

export type ProjectSummary = z.infer<typeof ProjectSummarySchema>;

/** The shape `fetchProjects` resolves to, for re-validating a list read back from disk. */
export const ProjectSummaryListSchema = z.array(ProjectSummarySchema).max(PROJECT_LIST_LIMIT);

const ProjectListResponseSchema = z.object({
  projects: z.array(z.unknown()).max(PROJECT_LIST_LIMIT).transform((items) => {
    const projects: ProjectSummary[] = [];
    for (const item of items) {
      const parsed = ProjectSummarySchema.safeParse(item);
      if (parsed.success && parsed.data.archivedAt === undefined) projects.push(parsed.data);
    }
    return projects;
  }),
});

export function fetchProjects(
  clerkToken: string,
  computerGatewayUrl: string,
): Promise<ProjectSummary[]> {
  let url: string;
  try {
    url = buildGatewayRequestUrl(computerGatewayUrl, "/api/workspace/projects", { visibility: "active" });
  } catch {
    return Promise.reject(new Error(PROJECTS_UNAVAILABLE_ERROR));
  }
  return fetchAuthenticatedJson({
    url,
    token: clerkToken,
    schema: ProjectListResponseSchema,
    errorMessage: PROJECTS_UNAVAILABLE_ERROR,
  }).then((response) => response.projects);
}

/**
 * - `name_taken`: another project already has the folder this name maps to.
 * - `invalid_name`: the name is empty, too long, or one the server will not take.
 * - `project_active`: work is still running in the project, so it cannot be archived.
 * - `conflict`: the project changed, or is shared and managed elsewhere.
 * - `not_found`: the project no longer exists.
 * - `unavailable`: anything else.
 */
export type ProjectRequestFailure =
  | "name_taken"
  | "invalid_name"
  | "project_active"
  | "conflict"
  | "not_found"
  | "unavailable";

// Written here, so safe to show; the server's own wording never reaches a screen.
const PROJECT_FAILURE_MESSAGES: Record<ProjectRequestFailure, string> = {
  name_taken: "A project with this name already exists.",
  invalid_name: "Enter a project name of up to 128 characters.",
  project_active: "Stop the work running in this project, then try again.",
  conflict: "This project changed. Refresh and try again.",
  not_found: "This project no longer exists.",
  unavailable: "Project could not be saved. Try again.",
};

/** Carries a reason and this app's wording for it; never the server's. */
export class ProjectRequestError extends Error {
  constructor(readonly reason: ProjectRequestFailure) {
    super(PROJECT_FAILURE_MESSAGES[reason]);
    this.name = "ProjectRequestError";
  }
}

export interface CreateProjectInput {
  name: string;
  /**
   * Makes a repeated attempt return the project the first one created instead
   * of a name conflict. Generate once per form submission and reuse on retry.
   */
  clientRequestId?: string;
}

const ProjectResponseSchema = z.object({ project: ProjectSummarySchema });
// ProjectLifecycleResult (packages/gateway/src/project-lifecycle.ts) for `archive`.
const ArchiveProjectResponseSchema = z.object({
  ok: z.literal(true),
  action: z.literal("archive"),
  project: ProjectSummarySchema,
});

const JSON_HEADERS = { "Content-Type": "application/json" };
const PROJECT_REFUSAL_STATUSES = [400, 404, 409];

function validProjectName(name: string): string | null {
  const trimmed = name.trim();
  return trimmed.length > 0 && trimmed.length <= PROJECT_NAME_MAX_LENGTH ? trimmed : null;
}

type RefusalReason = (status: number, code: string | null) => ProjectRequestFailure;

async function requestProject<T>(
  clerkToken: string,
  computerGatewayUrl: string,
  path: string,
  method: "POST" | "PATCH",
  body: unknown,
  schema: { parse(value: unknown): T },
  refusalReason: RefusalReason,
): Promise<T> {
  const url = gatewayRequestUrl(computerGatewayUrl, path);
  if (!url) throw new ProjectRequestError("unavailable");
  let answer: RequestAnswer<T>;
  try {
    answer = await fetchAuthenticatedAnswer({
      url,
      token: clerkToken,
      schema,
      errorMessage: PROJECT_FAILURE_MESSAGES.unavailable,
      refusalStatuses: PROJECT_REFUSAL_STATUSES,
      method,
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    });
  } catch (error: unknown) {
    console.warn("[mobile] project request failed", error instanceof Error ? error.name : "unknown");
    throw new ProjectRequestError("unavailable");
  }
  if (answer.ok) return answer.value;
  throw new ProjectRequestError(answer.status === 404 ? "not_found" : refusalReason(answer.status, answer.code));
}

/** `POST /api/projects`: a new empty project named `name`. */
export async function createProject(
  clerkToken: string,
  computerGatewayUrl: string,
  input: CreateProjectInput,
): Promise<ProjectSummary> {
  const name = validProjectName(input.name);
  if (!name) throw new ProjectRequestError("invalid_name");
  if (input.clientRequestId !== undefined && !CREATE_REQUEST_ID.test(input.clientRequestId)) {
    throw new ProjectRequestError("unavailable");
  }
  const response = await requestProject(
    clerkToken,
    computerGatewayUrl,
    "/api/projects",
    "POST",
    { name, ...(input.clientRequestId ? { clientRequestId: input.clientRequestId } : {}) },
    ProjectResponseSchema,
    // The body is a name (and a request id checked above), so a rejected body is a rejected name.
    (status, code) => status === 400 ? "invalid_name" : code === "slug_conflict" ? "name_taken" : "conflict",
  );
  return response.project;
}

/** `PATCH /api/projects/:slug`: changes the display name; the slug stays. */
export async function renameProject(
  clerkToken: string,
  computerGatewayUrl: string,
  slug: string,
  name: string,
): Promise<ProjectSummary> {
  const nextName = validProjectName(name);
  if (!nextName) throw new ProjectRequestError("invalid_name");
  if (!PROJECT_SLUG.test(slug)) throw new ProjectRequestError("not_found");
  const response = await requestProject(
    clerkToken,
    computerGatewayUrl,
    `/api/projects/${encodeURIComponent(slug)}`,
    "PATCH",
    { name: nextName },
    ProjectResponseSchema,
    (status) => status === 400 ? "invalid_name" : "conflict",
  );
  return response.project;
}

/**
 * `POST /api/projects/:slug/actions` with `{ type: "archive" }`. While work is
 * running in the project the server refuses with 409 `project_active`, which
 * rejects here as a `ProjectRequestError` with that reason.
 */
export async function archiveProject(
  clerkToken: string,
  computerGatewayUrl: string,
  slug: string,
): Promise<ProjectSummary> {
  if (!PROJECT_SLUG.test(slug)) throw new ProjectRequestError("not_found");
  const response = await requestProject(
    clerkToken,
    computerGatewayUrl,
    `/api/projects/${encodeURIComponent(slug)}/actions`,
    "POST",
    { type: "archive" },
    ArchiveProjectResponseSchema,
    (status, code) => status !== 409 ? "unavailable" : code === "project_active" ? "project_active" : "conflict",
  );
  return response.project;
}
