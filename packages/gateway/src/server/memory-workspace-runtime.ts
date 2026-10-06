import { Hono } from "hono";
import {
  requireRequestPrincipal,
  isRequestPrincipalError,
  mapRequestPrincipalError,
} from "../request-principal.js";
import {
  createMemoryWorkspaceRuntime,
  createMemoryWorkspaceRoutes,
} from "../memory-workspace/index.js";
import type { ChatAgentContext } from "../chat/agent-context.js";
/** Isolated composition keeps memory's pool and worker lifecycle out of the gateway entrypoint. */
export async function createGatewayMemoryWorkspace(
  databaseUrl: string | undefined,
) {
  const unavailable = new Hono();
  unavailable.all("*", (c) => {
    try {
      requireRequestPrincipal(c);
      return c.json({ error: "Memory workspace unavailable" }, 503);
    } catch (error: unknown) {
      if (!isRequestPrincipalError(error)) throw error;
      const mapped = mapRequestPrincipalError(
        error,
        "Memory workspace unavailable",
      );
      return c.json(mapped.body, mapped.status);
    }
  });
  if (!databaseUrl)
    return { routes: unavailable, memories: undefined, close: async () => {} };
  try {
    const runtime = await createMemoryWorkspaceRuntime({
      connectionString: databaseUrl,
    });
    const memories: NonNullable<
      ConstructorParameters<typeof ChatAgentContext>[0]["memories"]
    > = {
      resolve: (owner, refs) =>
        runtime.service.resolveChat(
          owner.ownerId,
          refs.map((ref) => ({
            id: ref.id,
            ...(ref.revision ? { revision: Number(ref.revision) } : {}),
          })),
        ),
      revalidate: (owner, snapshots) =>
        runtime.service.revalidateChat(owner.ownerId, snapshots),
    };
    const routes = createMemoryWorkspaceRoutes({
      service: runtime.service,
      getOwnerId: (c) => requireRequestPrincipal(c).userId,
    });
    runtime.start();
    return { routes, memories, close: () => runtime.close() };
  } catch (error: unknown) {
    console.error(
      "[memory-workspace] Startup failed",
      error instanceof Error ? error.name : "UnknownError",
    );
    return { routes: unavailable, memories: undefined, close: async () => {} };
  }
}
