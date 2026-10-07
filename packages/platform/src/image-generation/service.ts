import { createHash } from "node:crypto";
import { sql } from "kysely";
import { ImageGenerationRequestSchema, IMAGE_RESERVATION_MICROUSD, type ImageRuntimeIdentity } from "@matrix-os/contracts";
import { generateInteractionImage } from "@matrix-os/contracts/image-generation/server";
import type { PlatformDB } from "../db.js";
import type { PlatformImageConfig } from "./config.js";
export class PlatformImageError extends Error {
    constructor(readonly code: "unavailable" | "allowance_exhausted" | "request_conflict" | "busy" | "invalid_request") { super("Image generation is unavailable"); }
}
export function createPlatformImageService(options: {
    db: PlatformDB;
    config: PlatformImageConfig;
    fetchFn?: typeof fetch;
    now?: () => Date;
}) {
    const now = options.now ?? (() => new Date());
    const shutdown = new AbortController();
    // Bound local admission waiters too; durable admission separately caps dispatches.
    const running = new Set<Promise<unknown>>();
    async function generate(identity: ImageRuntimeIdentity, rawInput: unknown) {
        const config = options.config;
        if (!config.enabled || shutdown.signal.aborted)
            throw new PlatformImageError("unavailable");
        const parsed = ImageGenerationRequestSchema.safeParse(rawInput);
        if (!parsed.success)
            throw new PlatformImageError("invalid_request");
        const input = parsed.data;
        const at = now();
        const stamp = at.toISOString();
        const period = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1)).toISOString();
        const hash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
        await options.db.transaction(async (transaction) => {
            const trx = transaction.executor;
            // Global then owner locks serialize admission across machines/months. Never
            // expire an ambiguous provider dispatch and accidentally make it spendable.
            for (const owner of ["__image_global__", identity.ownerId]) {
                await trx.insertInto("image_owner_admissions").values({ owner_id: owner }).onConflict(c => c.column("owner_id").doNothing()).execute();
                await trx.selectFrom("image_owner_admissions").selectAll().where("owner_id", "=", owner).forUpdate().executeTakeFirstOrThrow();
            }
            if (shutdown.signal.aborted)
                throw new PlatformImageError("unavailable");
            const machine = await trx.selectFrom("user_machines").selectAll().where("machine_id", "=", identity.machineId).forUpdate().executeTakeFirst();
            if (!machine || machine.clerk_user_id !== identity.ownerId || machine.runtime_slot !== identity.runtimeSlot || machine.runtime_token_epoch !== identity.runtimeTokenEpoch || machine.status !== "running" || machine.activation_state !== "authorized" || machine.provisioning_class !== "customer" || machine.deleted_at !== null)
                throw new PlatformImageError("unavailable");
            const prior = await trx.selectFrom("image_generation_operations").selectAll().where("owner_id", "=", identity.ownerId).where("request_id", "=", input.requestId).executeTakeFirst();
            if (prior)
                throw new PlatformImageError("request_conflict");
            // Uncertain billing holds block that owner, but do not occupy an
            // active global dispatch slot forever. Crashed dispatches retain their
            // financial hold; their global capacity ages out beyond all timeouts.
            const ownerPending = await trx.selectFrom("image_generation_operations").select("request_id").where("owner_id", "=", identity.ownerId).where("state", "in", ["dispatching", "uncertain"]).limit(1).executeTakeFirst();
            const active = await trx.selectFrom("image_generation_operations").select("request_id").where("state", "=", "dispatching").where("created_at", ">", new Date(at.getTime() - 5 * 60_000).toISOString()).limit(2).execute();
            if (ownerPending || active.length >= 2) throw new PlatformImageError("busy");
            const monthlyOperations = await trx.selectFrom("image_generation_operations").select(({ fn }) => fn.countAll<string>().as("count")).where("owner_id", "=", identity.ownerId).where("period_start", "=", period).executeTakeFirstOrThrow();
            if (Number(monthlyOperations.count) >= 4096)
                throw new PlatformImageError("busy");
            await trx.insertInto("image_monthly_allowances").values({ owner_id: identity.ownerId, period_start: period, granted_microusd: config.monthlyAllowanceMicrousd, spent_microusd: 0, reserved_microusd: 0 }).onConflict(c => c.columns(["owner_id", "period_start"]).doNothing()).execute();
            const held = await trx.updateTable("image_monthly_allowances").set({ reserved_microusd: sql<number> `reserved_microusd + ${IMAGE_RESERVATION_MICROUSD}` }).where("owner_id", "=", identity.ownerId).where("period_start", "=", period).where(sql<boolean> `granted_microusd - spent_microusd - reserved_microusd >= ${IMAGE_RESERVATION_MICROUSD}`).returningAll().executeTakeFirst();
            if (!held)
                throw new PlatformImageError("allowance_exhausted");
            await trx.insertInto("image_generation_operations").values({ owner_id: identity.ownerId, request_id: input.requestId, machine_id: identity.machineId, runtime_slot: identity.runtimeSlot, period_start: period, payload_hash: hash, state: "dispatching", reserved_microusd: IMAGE_RESERVATION_MICROUSD, actual_microusd: null, created_at: stamp, updated_at: stamp }).execute();
        });
        try {
            const result = await generateInteractionImage(config.apiKey, input, options.fetchFn, shutdown.signal);
            await options.db.transaction(async (transaction) => {
                const trx = transaction.executor;
                const op = await trx.updateTable("image_generation_operations").set({ state: "succeeded", actual_microusd: result.costMicrousd, updated_at: now().toISOString() }).where("owner_id", "=", identity.ownerId).where("request_id", "=", input.requestId).where("state", "=", "dispatching").returningAll().executeTakeFirst();
                if (!op)
                    throw new PlatformImageError("unavailable");
                const balance = await trx.updateTable("image_monthly_allowances").set({ spent_microusd: sql<number> `spent_microusd + ${result.costMicrousd}`, reserved_microusd: sql<number> `reserved_microusd - ${IMAGE_RESERVATION_MICROUSD}` }).where("owner_id", "=", identity.ownerId).where("period_start", "=", period).where("reserved_microusd", ">=", IMAGE_RESERVATION_MICROUSD).returning("owner_id").executeTakeFirst();
                if (!balance)
                    throw new PlatformImageError("unavailable");
            });
            return result;
        }
        catch (error: unknown) {
            console.warn("[platform-images] dispatch or settlement failed", error instanceof Error ? error.name : "UnknownError");
            // A timeout, malformed response or crash is not evidence of no charge.
            await options.db.executor.updateTable("image_generation_operations").set({ state: "uncertain", updated_at: now().toISOString() }).where("owner_id", "=", identity.ownerId).where("request_id", "=", input.requestId).where("state", "=", "dispatching").execute();
            throw new PlatformImageError("unavailable");
        }
    }
    return {
        async generate(identity: ImageRuntimeIdentity, rawInput: unknown) {
            if (shutdown.signal.aborted)
                throw new PlatformImageError("unavailable");
            if (running.size >= 32)
                throw new PlatformImageError("busy");
            const task = generate(identity, rawInput);
            running.add(task);
            try {
                return await task;
            }
            finally {
                running.delete(task);
            }
        },
        async shutdown() { shutdown.abort(); await Promise.allSettled([...running]); },
    };
}
export type PlatformImageService = ReturnType<typeof createPlatformImageService>;
