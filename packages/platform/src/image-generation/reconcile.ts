import { sql } from "kysely";
import { z } from "zod/v4";
import type { PlatformDB } from "../db.js";
const Review = z.object({
    ownerId: z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/),
    requestId: z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/),
    actualMicrousd: z.number().int().min(0).max(1000000),
    evidenceReference: z.string().min(8).max(256).regex(/^[A-Za-z0-9_./:-]+$/),
}).strict();
/** Platform operator primitive, deliberately absent from runtime tools/routes.
 * Call only after reviewing exact billed usage or authoritative no-charge proof.
 * Neither an expired request nor an expired month proves that a charge is zero.
 */
export async function reconcilePlatformImageOperation(db: PlatformDB, rawReview: unknown, at = new Date()): Promise<void> {
    const review = Review.parse(rawReview);
    await db.transaction(async (transaction) => {
        const trx = transaction.executor;
        for (const owner of ["__image_global__", review.ownerId]) {
            await trx.insertInto("image_owner_admissions").values({ owner_id: owner }).onConflict(c => c.column("owner_id").doNothing()).execute();
            await trx.selectFrom("image_owner_admissions").selectAll().where("owner_id", "=", owner).forUpdate().executeTakeFirstOrThrow();
        }
        const op = await trx.selectFrom("image_generation_operations").selectAll().where("owner_id", "=", review.ownerId).where("request_id", "=", review.requestId).forUpdate().executeTakeFirst();
        if (!op)
            throw new Error("Image review is unavailable");
        if (op.state === "succeeded" && Number(op.actual_microusd) === review.actualMicrousd && op.reconciliation_evidence === review.evidenceReference)
            return;
        // A crashed dispatch must be beyond every configured provider/transport timeout.
        if (!Number.isFinite(new Date(op.updated_at).getTime()) || op.state === "succeeded" || review.actualMicrousd > Number(op.reserved_microusd)
            || (op.state === "dispatching" && new Date(op.updated_at).getTime() > at.getTime() - 5 * 60000))
            throw new Error("Image review is unavailable");
        await trx.updateTable("image_generation_operations").set({ state: "succeeded", actual_microusd: review.actualMicrousd, reconciliation_evidence: review.evidenceReference, updated_at: at.toISOString() }).where("owner_id", "=", review.ownerId).where("request_id", "=", review.requestId).where("state", "=", op.state).returning("request_id").executeTakeFirstOrThrow();
        const balance = await trx.updateTable("image_monthly_allowances").set({ spent_microusd: sql<number> `spent_microusd + ${review.actualMicrousd}`, reserved_microusd: sql<number> `reserved_microusd - ${op.reserved_microusd}` }).where("owner_id", "=", review.ownerId).where("period_start", "=", op.period_start).where("reserved_microusd", ">=", Number(op.reserved_microusd)).returning("owner_id").executeTakeFirst();
        if (!balance)
            throw new Error("Image review is unavailable");
    });
}
