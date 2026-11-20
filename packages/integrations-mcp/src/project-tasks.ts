import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  createProjectTaskHttpClient, ProjectTaskClientError, resolveProjectSlug, type ProjectTaskSession,
} from "@matrix-os/contracts/project-task-client";
import { ProjectIdSchema, TaskIdSchema } from "@matrix-os/contracts/project-tasks";
import { gatewayAuthHeaders, type GatewayFetcher } from "../../kernel/dist/tools/integrations.js";
import { projectTaskToolDefinitions } from "../../kernel/dist/tools/project-tasks.js";

/**
 * The project board tools on the integrations MCP server. A chat run's token is
 * bounded by the gateway to the run's project, which reports it (and the actor is
 * the chat). A terminal task session's MATRIX_PROJECT_ID (and MATRIX_TASK_ID),
 * forwarded by the launcher, keeps owner-credential tools in that project.
 */
export function registerProjectTaskTools(
  server: McpServer,
  fetcher: GatewayFetcher = fetch,
  options: { readOnly?: boolean; env?: NodeJS.ProcessEnv } = {},
): void {
  const env = options.env ?? process.env;
  const client = createProjectTaskHttpClient({
    baseUrl: env.GATEWAY_URL ?? "http://localhost:4000",
    headers: gatewayAuthHeaders,
    fetch: async (url, init) => {
      const response = await fetcher(url, init);
      // Bounded reads need a streaming body; a non-standard response is refused.
      if (!(response instanceof Response)) throw new ProjectTaskClientError("unavailable");
      return response;
    },
  });
  let pending: Promise<ProjectTaskSession | null> | undefined;

  async function bind(): Promise<ProjectTaskSession | null> {
    const projectId = env.MATRIX_PROJECT_ID || undefined;
    const envTaskId = env.MATRIX_TASK_ID || undefined;
    // A malformed or partial binding must never widen the session to every project.
    if ((projectId !== undefined && !ProjectIdSchema.safeParse(projectId).success)
      || (envTaskId !== undefined && (!TaskIdSchema.safeParse(envTaskId).success || projectId === undefined))) {
      throw new ProjectTaskClientError("task_forbidden");
    }
    if (env.MATRIX_AGENT_INTEGRATIONS_TOKEN !== undefined) {
      // A chat run's token: the gateway bounds it to the run's project and says which one.
      const bound = await client.getSession();
      if (!bound || (projectId !== undefined && bound.projectId !== projectId)) throw new ProjectTaskClientError("task_forbidden");
      return bound;
    }
    // Owner credentials (a terminal agent's MCP): the session's own env bounds the tools.
    if (projectId === undefined) return null;
    const projectSlug = await resolveProjectSlug(client, projectId);
    return { projectId, projectSlug, ...(envTaskId ? { taskId: envTaskId } : {}) };
  }

  function session(): Promise<ProjectTaskSession | null> {
    pending ??= bind().catch((error: unknown) => { pending = undefined; throw error; });
    return pending;
  }

  for (const definition of projectTaskToolDefinitions({ client, session }, { readOnly: options.readOnly === true })) {
    server.registerTool(
      definition.name,
      { description: definition.description, inputSchema: definition.schema, annotations: definition.annotations },
      async (input: unknown) => definition.handler(input),
    );
  }
}
