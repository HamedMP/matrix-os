import type { Context } from "hono";
import { MATRIX_MCP_RUN_CONTEXT_KEY, type MatrixMcpRunContext } from "../chat/matrix-mcp-launch.js";
import { previewDriveActionCanonical } from "@matrix-os/contracts";

export const MATRIX_PREVIEW_DRIVE_ACTION_GRANT_KEY = "matrixPreviewDriveActionGrant";

/** Called after auth and bodyLimit, before local execution or Platform forwarding. */
export async function authorizeChatIntegrationRequest(c: Context, options?: { localRoutes?: boolean }): Promise<Response | null> {
  const run = c.get(MATRIX_MCP_RUN_CONTEXT_KEY as never) as MatrixMcpRunContext | undefined;
  if (run?.scope === "preview_drive_call") {
    // The Preview delegation exists only on the production Platform broker path.
    // Local integration routes could reveal a broader inventory or skip its one-use grant.
    if (options?.localRoutes) return c.json({ error: "Integration unavailable" }, 503);
    if (c.req.method === "GET") return null;
    if (c.req.method !== "POST" || c.req.path !== "/api/integrations/call"
      || new URL(c.req.url).search || !run.previewDrive) return c.json({ error: "Integration action approval required" }, 403);
    let body: unknown;
    try { body = await c.req.raw.clone().json(); }
    catch (error: unknown) {
      console.warn("[integrations] Invalid Preview Drive action", error instanceof Error ? error.name : "UnknownError");
      return c.json({ error: "Invalid integration action" }, 400);
    }
    if (!previewDriveActionCanonical(body)) return c.json({ error: "Integration action approval required" }, 403);
    const grant = run.previewDrive.consumeActionGrant(body, c.req.header("x-matrix-integration-approval"));
    if (!grant) return c.json({ error: "Integration action approval required" }, 403);
    c.set(MATRIX_PREVIEW_DRIVE_ACTION_GRANT_KEY as never, grant as never);
    return null;
  }
  if (run?.scope !== "chat_call" && run?.scope !== "chat_discovery") return null;
  if (c.req.method === "GET") return null;
  if (run.scope !== "chat_call" || !run.consumeIntegrationRequest || new URL(c.req.url).search) {
    return c.json({ error: "Integration action approval required" }, 403);
  }
  let body: unknown = {};
  try {
    const text = await c.req.raw.clone().text();
    if (text) body = JSON.parse(text);
  } catch (error: unknown) {
    console.warn("[chat-integrations] Invalid action body", error instanceof Error ? error.name : "UnknownError");
    return c.json({ error: "Invalid integration action" }, 400);
  }
  return run.consumeIntegrationRequest(c.req.method, c.req.path, body, c.req.header("x-matrix-integration-approval"))
    ? null : c.json({ error: "Integration action approval required" }, 403);
}
