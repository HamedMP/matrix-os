import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod/v4";
import { ImageGenerationRequestSchema } from "@matrix-os/contracts";
import { getRunningUserMachineByHandle, type PlatformDB } from "../db.js";
import { buildPlatformImageRuntimeVerificationToken, timingSafeTokenEquals } from "../platform-token.js";
import { PlatformImageError, type PlatformImageService } from "./service.js";
import { RuntimeSlotSchema } from "../customer-vps-schema.js";
import { safeImageErrorDetails } from "@matrix-os/contracts/image-generation/server";
export function createImageGenerationRoutes(options: {
    db: PlatformDB;
    platformSecret: string;
    service: PlatformImageService;
}) {
    const app = new Hono();
    app.use("*", async (c, next) => { c.header("Cache-Control", "no-store, private"); c.header("CDN-Cache-Control", "no-store"); c.header("Cloudflare-CDN-Cache-Control", "no-store"); c.header("Surrogate-Control", "no-store"); await next(); });
    app.post("/", bodyLimit({ maxSize: 32 * 1024, onError: c => c.json({ error: "Invalid image request" }, 413) }), async (c) => {
        const handle = z.string().min(1).max(63).regex(/^[a-z0-9][a-z0-9-]*$/).safeParse(c.req.param("handle"));
        const query = z.object({ runtimeSlot: RuntimeSlotSchema }).strict().safeParse(Object.fromEntries(new URL(c.req.url).searchParams));
        if (!handle.success || !query.success)
            return c.json({ error: "Invalid image request" }, 400);
        let requestId: string | undefined;
        let ownerId: string | undefined;
        try {
            const machine = await getRunningUserMachineByHandle(options.db, handle.data, query.data.runtimeSlot);
            const header = c.req.header("authorization");
            const bearer = header?.startsWith("Bearer ") && header.length < 1024 ? header.slice(7) : undefined;
            if (!machine || !timingSafeTokenEquals(bearer, buildPlatformImageRuntimeVerificationToken({ handle: handle.data, machineId: machine.machineId, runtimeSlot: machine.runtimeSlot }, options.platformSecret, machine.runtimeTokenEpoch)))
                return c.json({ error: "Unauthorized" }, 401);
            ownerId = machine.clerkUserId;
            let raw: unknown;
            try {
                raw = await c.req.json();
            }
            catch (error: unknown) {
                if (!(error instanceof SyntaxError))
                    throw error;
                return c.json({ error: "Invalid image request" }, 400);
            }
            const request = ImageGenerationRequestSchema.safeParse(raw);
            if (!request.success)
                return c.json({ error: "Invalid image request" }, 400);
            requestId = request.data.requestId;
            return c.json(await options.service.generate({ ownerId: machine.clerkUserId, machineId: machine.machineId, runtimeSlot: machine.runtimeSlot, runtimeTokenEpoch: machine.runtimeTokenEpoch }, request.data));
        }
        catch (error: unknown) {
            if (error instanceof Error && error.name === "BodyLimitError")
                return c.json({ error: "Invalid image request" }, 413);
            if (error instanceof PlatformImageError) {
                console.warn("[platform-images] request declined", { requestId, ownerId, handle: handle.data, runtimeSlot: query.data.runtimeSlot, code: error.code });
                const status = error.code === "allowance_exhausted" ? 402 : error.code === "busy" ? 429 : error.code === "request_conflict" ? 409 : error.code === "invalid_request" ? 400 : 503;
                return c.json({ error: "Image generation is unavailable" }, status);
            }
            console.warn("[platform-images] request failed", { requestId, ownerId, handle: handle.data, runtimeSlot: query.data.runtimeSlot, ...safeImageErrorDetails(error) });
            return c.json({ error: "Image generation is unavailable" }, 503);
        }
    });
    return app;
}
