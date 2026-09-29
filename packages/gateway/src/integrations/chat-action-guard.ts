import type { Context } from "hono";
import { MATRIX_MCP_RUN_CONTEXT_KEY, type MatrixMcpRunContext } from "../chat/matrix-mcp-launch.js";

/** Called after auth and bodyLimit, before local execution or Platform forwarding. */
export async function authorizeChatIntegrationRequest(c: Context): Promise<Response | null> {
  const run = c.get(MATRIX_MCP_RUN_CONTEXT_KEY as never) as MatrixMcpRunContext | undefined;
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
