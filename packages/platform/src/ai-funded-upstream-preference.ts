import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  FundedAiUpstreamPreferenceSchema,
  FundedAiUpstreamPreferenceValueSchema,
  FundedAiUpstreamSelectionSchema,
  IsoTimestampSchema,
  ProviderModelReferenceSchema,
  type FundedAiUpstreamPreference,
  type FundedAiUpstreamSelection,
} from "@matrix-os/contracts";
import { sql } from "kysely";
import { z } from "zod/v4";
import type { PlatformDB } from "./db.js";
import { AiFundedPolicyError } from "./ai-funded-policy-errors.js";

const OwnerIdSchema = z.string().regex(/^user_[A-Za-z0-9]{4,128}$/);
const CohortSchema = z.array(OwnerIdSchema).length(4)
  .refine((values) => new Set(values).size === values.length, "Owner IDs must be unique");
const ModelIdsSchema = z.array(ProviderModelReferenceSchema).min(1).max(8)
  .refine((values) => new Set(values).size === values.length, "Model IDs must be unique");
const MAX_CONFIG_WINDOW_MS = 30 * 24 * 60 * 60_000;
const SELECTION_TTL_MS = 30_000;

export type AiFundedUpstreamPreferenceConfig = { enabled: false } | {
  enabled: true;
  ownerIds: readonly string[];
  bedrockModelIds: readonly string[];
  validThrough: string;
};

export interface FundedBedrockProbeResult {
  ready: boolean;
  checkedAt: string;
  staleAfter: string;
  priceValidThrough?: string;
}

export function loadAiFundedUpstreamPreferenceConfig(
  env: NodeJS.ProcessEnv,
  now = new Date(),
): AiFundedUpstreamPreferenceConfig {
  if (env.AI_FUNDED_UPSTREAM_PREFERENCE_ENABLED !== "true") return { enabled: false };
  let rawModels: unknown;
  try {
    rawModels = JSON.parse(env.AI_FUNDED_BEDROCK_MODEL_IDS ?? "") as unknown;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new Error("Funded AI upstream preference is misconfigured");
  }
  const ownerIds = CohortSchema.safeParse((env.AI_FUNDED_UPSTREAM_PREFERENCE_OWNER_IDS ?? "").split(","));
  const bedrockModelIds = ModelIdsSchema.safeParse(rawModels);
  const validThrough = IsoTimestampSchema.safeParse(env.AI_FUNDED_UPSTREAM_PREFERENCE_VALID_THROUGH);
  if (!ownerIds.success || !bedrockModelIds.success || !validThrough.success
    || Date.parse(validThrough.data) - now.getTime() > MAX_CONFIG_WINDOW_MS) {
    throw new Error("Funded AI upstream preference is misconfigured");
  }
  if (Date.parse(validThrough.data) <= now.getTime()) return { enabled: false };
  return { enabled: true, ownerIds: ownerIds.data, bedrockModelIds: bedrockModelIds.data, validThrough: validThrough.data };
}

const SetPreferenceSchema = z.object({
  ownerId: OwnerIdSchema,
  actorOwnerId: OwnerIdSchema,
  idempotencyKey: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1),
  selectedUpstream: FundedAiUpstreamPreferenceValueSchema,
}).strict();

function selectionPayload(input: {
  ownerId: string;
  modelId: string;
  selection: Omit<FundedAiUpstreamSelection, "proof">;
}): string {
  return JSON.stringify([
    input.ownerId,
    input.modelId,
    input.selection.upstream,
    input.selection.preferenceRevision,
    input.selection.checkedAt,
    input.selection.staleAfter,
  ]);
}

export function createAiFundedUpstreamPreferenceRepository(options: {
  db: PlatformDB;
  config: AiFundedUpstreamPreferenceConfig;
  selectionSecret: string;
  probeBedrock: (modelId: string) => Promise<FundedBedrockProbeResult>;
  now?: () => Date;
}) {
  if (!options.db?.kysely || options.selectionSecret.length < 32 || !options.config?.enabled || !options.probeBedrock) {
    throw new Error("Funded AI upstream preference dependencies are missing");
  }
  const config = options.config;
  const now = options.now ?? (() => new Date());
  const entitled = (ownerId: string) => Date.parse(config.validThrough) > now().getTime()
    && config.ownerIds.includes(ownerId);

  async function getPreference(ownerIdInput: string): Promise<FundedAiUpstreamPreference | null> {
    const ownerId = OwnerIdSchema.parse(ownerIdInput);
    if (!entitled(ownerId)) return null;
    await options.db.ready;
    const row = await options.db.executor.selectFrom("ai_funded_upstream_preferences")
      .selectAll().where("owner_id", "=", ownerId).executeTakeFirst();
    return FundedAiUpstreamPreferenceSchema.parse(row ? {
      selectedUpstream: row.selected_upstream,
      revision: row.revision,
      updatedAt: row.updated_at,
      validThrough: config.validThrough,
    } : {
      selectedUpstream: "cloudflare",
      revision: 0,
      updatedAt: null,
      validThrough: config.validThrough,
    });
  }

  async function setPreference(input: z.input<typeof SetPreferenceSchema>): Promise<FundedAiUpstreamPreference> {
    const request = SetPreferenceSchema.parse(input);
    if (request.actorOwnerId !== request.ownerId || !entitled(request.ownerId)) {
      throw new AiFundedPolicyError("not_found");
    }
    const updatedAt = now().toISOString();
    const eventId = `upstream-preference:${createHash("sha256")
      .update(`${request.ownerId}\0${request.idempotencyKey}`).digest("hex")}`;
    await options.db.ready;
    return options.db.transaction(async (trx) => {
      // Share authorization's owner lock so a preference revision cannot
      // change between selection verification and reservation creation.
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`funded-ai-owner:${request.ownerId}`}, 0))`
        .execute(trx.executor);
      const replay = await trx.executor.selectFrom("ai_funded_upstream_preference_audit")
        .selectAll().where("event_id", "=", eventId).executeTakeFirst();
      if (replay) {
        if (replay.owner_id !== request.ownerId || replay.actor_owner_id !== request.actorOwnerId
          || replay.previous_revision !== request.expectedRevision
          || replay.selected_upstream !== request.selectedUpstream) {
          throw new AiFundedPolicyError("idempotency_conflict");
        }
        return FundedAiUpstreamPreferenceSchema.parse({
          selectedUpstream: replay.selected_upstream,
          revision: replay.revision,
          updatedAt: replay.created_at,
          validThrough: config.validThrough,
        });
      }
      const stored = await trx.executor.selectFrom("ai_funded_upstream_preferences")
        .selectAll().where("owner_id", "=", request.ownerId).forUpdate().executeTakeFirst();
      const previousRevision = stored?.revision ?? 0;
      const previousUpstream = stored?.selected_upstream ?? "cloudflare";
      if (previousRevision !== request.expectedRevision) throw new AiFundedPolicyError("revision_conflict");
      const revision = previousRevision + 1;
      const updated = stored
        ? await trx.executor.updateTable("ai_funded_upstream_preferences").set({
            selected_upstream: request.selectedUpstream,
            revision,
            updated_at: updatedAt,
          }).where("owner_id", "=", request.ownerId)
            .where("revision", "=", request.expectedRevision)
            .returningAll().executeTakeFirst()
        : await trx.executor.insertInto("ai_funded_upstream_preferences").values({
            owner_id: request.ownerId,
            selected_upstream: request.selectedUpstream,
            revision,
            updated_at: updatedAt,
          }).onConflict((conflict) => conflict.column("owner_id").doNothing())
            .returningAll().executeTakeFirst();
      if (!updated) throw new AiFundedPolicyError("revision_conflict");
      await trx.executor.insertInto("ai_funded_upstream_preference_audit").values({
        event_id: eventId,
        owner_id: request.ownerId,
        actor_owner_id: request.actorOwnerId,
        previous_upstream: previousUpstream,
        selected_upstream: request.selectedUpstream,
        previous_revision: previousRevision,
        revision,
        created_at: updatedAt,
      }).execute();
      return FundedAiUpstreamPreferenceSchema.parse({
        selectedUpstream: updated.selected_upstream,
        revision: updated.revision,
        updatedAt: updated.updated_at,
        validThrough: config.validThrough,
      });
    });
  }

  function sign(ownerId: string, modelId: string, selection: Omit<FundedAiUpstreamSelection, "proof">): FundedAiUpstreamSelection {
    const proof = createHmac("sha256", options.selectionSecret)
      .update(selectionPayload({ ownerId, modelId, selection })).digest("hex");
    return FundedAiUpstreamSelectionSchema.parse({ ...selection, proof });
  }

  async function resolveUpstreamWithProbe(
    input: { ownerId: string; modelId: string },
    probeBedrock: (modelId: string) => Promise<FundedBedrockProbeResult>,
  ): Promise<{ selection: FundedAiUpstreamSelection; bedrockProbe?: FundedBedrockProbeResult }> {
    const ownerId = OwnerIdSchema.parse(input.ownerId);
    const modelId = ProviderModelReferenceSchema.parse(input.modelId);
    const preference = await getPreference(ownerId);
    let probe: FundedBedrockProbeResult | undefined;
    if (preference?.selectedUpstream === "aws_bedrock" && config.bedrockModelIds.includes(modelId)) {
      probe = await probeBedrock(modelId);
    }
    const checked = now();
    let upstream: "cloudflare" | "aws_bedrock" = "cloudflare";
    let staleAt = checked.getTime() + SELECTION_TTL_MS;
    if (probe) {
      const probeChecked = Date.parse(probe.checkedAt);
      const probeStale = Date.parse(probe.staleAfter);
      const priceValidThrough = Date.parse(probe.priceValidThrough ?? "");
      if (probe.ready && Number.isFinite(probeChecked) && probeChecked <= checked.getTime()
        && Number.isFinite(probeStale) && probeStale > checked.getTime()
        && Number.isFinite(priceValidThrough) && priceValidThrough > checked.getTime()) {
        upstream = "aws_bedrock";
        staleAt = Math.min(staleAt, probeStale, priceValidThrough, Date.parse(config.validThrough));
      }
    }
    const selection = {
      upstream,
      preferenceRevision: preference?.revision ?? 0,
      checkedAt: checked.toISOString(),
      staleAfter: new Date(staleAt).toISOString(),
    } as const;
    return { selection: sign(ownerId, modelId, selection), ...(probe ? { bedrockProbe: probe } : {}) };
  }

  async function resolveUpstream(input: { ownerId: string; modelId: string }): Promise<FundedAiUpstreamSelection> {
    return (await resolveUpstreamWithProbe(input, options.probeBedrock)).selection;
  }

  async function resolveUpstreamForReadiness(
    input: { ownerId: string; modelId: string },
    probeBedrock: (modelId: string) => Promise<FundedBedrockProbeResult>,
  ) {
    return resolveUpstreamWithProbe(input, probeBedrock);
  }

  function getEntitledBedrockModelIds(ownerIdInput: string): readonly string[] {
    const ownerId = OwnerIdSchema.parse(ownerIdInput);
    return entitled(ownerId) ? config.bedrockModelIds : [];
  }

  async function verifyUpstream(input: {
    ownerId: string;
    modelId: string;
    selection: FundedAiUpstreamSelection;
  }): Promise<boolean> {
    const parsed = FundedAiUpstreamSelectionSchema.safeParse(input.selection);
    if (!parsed.success || Date.parse(parsed.data.checkedAt) > now().getTime()
      || Date.parse(parsed.data.staleAfter) <= now().getTime()) return false;
    const expected = createHmac("sha256", options.selectionSecret).update(selectionPayload({
      ownerId: input.ownerId,
      modelId: input.modelId,
      selection: parsed.data,
    })).digest();
    const supplied = Buffer.from(parsed.data.proof, "hex");
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return false;
    if (parsed.data.upstream === "cloudflare") return true;
    if (!entitled(input.ownerId) || !config.bedrockModelIds.includes(input.modelId)) return false;
    const preference = await getPreference(input.ownerId);
    return preference?.selectedUpstream === "aws_bedrock"
      && preference.revision === parsed.data.preferenceRevision;
  }

  async function getPreferenceView(
    ownerId: string,
    probeBedrock: (modelId: string) => Promise<FundedBedrockProbeResult> = options.probeBedrock,
  ) {
    const preference = await getPreference(ownerId);
    if (!preference) return null;
    let effectiveUpstream: "cloudflare" | "aws_bedrock" = "cloudflare";
    if (preference.selectedUpstream === "aws_bedrock") {
      const selections = await Promise.all(config.bedrockModelIds.map(modelId =>
        resolveUpstreamWithProbe({ ownerId, modelId }, probeBedrock).then(({ selection }) => selection)));
      if (selections.some(selection => selection.upstream === "aws_bedrock")) effectiveUpstream = "aws_bedrock";
    }
    return { ...preference, effectiveUpstream } as const;
  }

  return { getPreference, getPreferenceView, setPreference, resolveUpstream,
    resolveUpstreamForReadiness, getEntitledBedrockModelIds, verifyUpstream };
}

export type AiFundedUpstreamPreferenceRepository = ReturnType<typeof createAiFundedUpstreamPreferenceRepository>;
