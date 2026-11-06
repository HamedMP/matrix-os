import { z } from "zod/v4";
import { PreviewPairActorSchema, PreviewPairIdSchema } from "@matrix-os/contracts/preview-pair";
import type { PlatformDB } from "../db.js";
import { readPreviewPair } from "./repository.js";

/** Kind is assigned by the configured verifier, never a token/header/body hint. */
export const PreviewPairReaderSchema = z.strictObject({ actorId: PreviewPairActorSchema,
  kind: z.enum(["control", "preview"]), expiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) });
export type PreviewPairReader = z.infer<typeof PreviewPairReaderSchema>;
export type PreviewPairMaintainerCheck = (actorId: string) => Promise<boolean>;
export class PreviewPairAccessError extends Error {
  constructor(readonly status: 401 | 403 | 404 | 503) { super("Preview pair is unavailable"); this.name = "PreviewPairAccessError"; }
}
export function verifiedPreviewPairReader(raw: unknown, now: number): PreviewPairReader {
  const parsed = PreviewPairReaderSchema.safeParse(raw);
  if (!parsed.success || !Number.isFinite(now) || parsed.data.expiresAt <= now) throw new PreviewPairAccessError(401);
  return parsed.data;
}

export async function authorizePreviewPairReader(db: PlatformDB, pairId: string, raw: unknown,
  isMaintainer: PreviewPairMaintainerCheck, now: number) {
  PreviewPairIdSchema.parse(pairId);
  const reader = verifiedPreviewPairReader(raw, now);
  await db.ready;
  const pair = await readPreviewPair(db, pairId);
  if (!pair) throw new PreviewPairAccessError(404);
  if (reader.kind === "control" && (reader.actorId === pair.requester_id || await isMaintainer(reader.actorId))) return pair;
  if (reader.kind === "preview" && pair.fixture_id) {
    const fixture = await db.executor.selectFrom("preview_pair_fixtures").select(["owner_actor_id", "member_actor_id"])
      .where("fixture_id", "=", pair.fixture_id).where("active_pair_id", "=", pairId).executeTakeFirst();
    if (fixture && [fixture.owner_actor_id, fixture.member_actor_id].includes(reader.actorId)) return pair;
  }
  // Unknown and unauthorized reports have the same response: no existence oracle.
  throw new PreviewPairAccessError(404);
}
