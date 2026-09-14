import { z } from "zod/v4";

import { buildGatewayRequestUrl, fetchAuthenticatedJson } from "@/lib/requests/http";

const PROJECTS_UNAVAILABLE_ERROR = "Projects unavailable. Try again.";
const PROJECT_LIST_LIMIT = 200;

// Matches ProjectConfig (packages/gateway/src/project-manager.ts) -- an
// internal server interface, not a shared @matrix-os/contracts schema, so
// validated here against only the fields the picker actually needs.
const ProjectSummarySchema = z.object({
  id: z.string().min(1).max(160),
  slug: z.string().min(1).max(160),
  name: z.string().min(1).max(240),
  kind: z.enum(["scratch", "github", "folder"]),
  archivedAt: z.string().optional(),
  github: z.object({
    owner: z.string(),
    repo: z.string(),
  }).loose().optional(),
});

export type ProjectSummary = z.infer<typeof ProjectSummarySchema>;

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
