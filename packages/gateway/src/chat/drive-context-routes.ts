import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { ChatDriveSearchInputSchema, ChatDriveReadInputSchema } from "@matrix-os/contracts";
import { z } from "zod/v4";
import { MATRIX_MCP_RUN_CONTEXT_KEY, type MatrixMcpRunContext } from "./matrix-mcp-launch.js";
import type { createChatDriveContext } from "./drive-context.js";
const failure = (c: Context, status: 403 | 413 | 422 | 503) => { c.header("Cache-Control", "private, no-store"); return c.json({ error: "Company drive context is unavailable" }, status); };
/** Ordinary user or machine bearers cannot impersonate an admitted model Run. */
export function createChatDriveToolRoutes(options: {
    service: ReturnType<typeof createChatDriveContext> | null;
}): Hono {
    const app = new Hono();
    for (const action of ["search", "read"] as const) {
        app.post(`/api/chat-drive-context/${action}`, bodyLimit({ maxSize: 4096, onError: c => failure(c, 413) }), async (c) => {
            const scope = c.get(MATRIX_MCP_RUN_CONTEXT_KEY as never) as MatrixMcpRunContext | undefined;
            if (!scope?.driveContext)
                return failure(c, 403);
            if (!options.service)
                return failure(c, 503);
            try {
                const value = await c.req.json();
                const signal = c.req.raw.signal;
                const result = action === "search" ? await options.service.search(scope.actorId, scope.runId, ChatDriveSearchInputSchema.parse(value), signal) : await options.service.read(scope.actorId, scope.runId, ChatDriveReadInputSchema.parse(value), signal);
                c.header("Cache-Control", "private, no-store");
                return c.json(result);
            }
            catch (error: unknown) {
                if (error instanceof Error && error.name === "BodyLimitError")
                    return failure(c, 413);
                if (error instanceof z.ZodError || error instanceof SyntaxError)
                    return failure(c, 422);
                console.warn("[chat/drive-context] Tool unavailable", error instanceof Error ? error.name : "UnknownError");
                return failure(c, 503);
            }
        });
    }
    return app;
}
