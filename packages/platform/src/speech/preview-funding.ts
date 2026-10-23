import { createHmac } from "node:crypto";
import { sql } from "kysely";
import type { SpeechFundingPort } from "./service.js";
import { SpeechFundingError } from "./funding.js";
import { isBoundedPreviewProvisioningClass } from "../preview-runtime-access.js";

const PREFIX = "preview_speech_";

export function createPreviewAwareSpeechFundingPort(options: {
  paid: SpeechFundingPort;
  previewSecret: string;
  now?: () => Date;
}): SpeechFundingPort {
  if (!options.paid || options.previewSecret.length < 32) throw new Error("Preview speech funding is misconfigured");
  const now = options.now ?? (() => new Date());
  return {
    async reserve(trx, input) {
      const machine = await trx.selectFrom("user_machines").select([
        "provisioning_class", "clerk_user_id", "runtime_slot", "runtime_token_epoch",
        "status", "activation_state", "deleted_at",
      ]).where("machine_id", "=", input.identity.machineId).executeTakeFirst();
      if (!machine || !isBoundedPreviewProvisioningClass(machine.provisioning_class)) {
        return options.paid.reserve(trx, input);
      }
      if (machine.clerk_user_id !== input.identity.ownerId || machine.runtime_slot !== input.identity.runtimeSlot
        || machine.status !== "running" || machine.activation_state !== "authorized" || machine.deleted_at !== null) {
        throw new SpeechFundingError("allowance_exhausted");
      }
      const at = now().toISOString();
      const updated = await trx.updateTable("preview_runtime_allocations").set({
        speech_requests_used: sql<number>`speech_requests_used + 1`,
        updated_at: at,
      }).where("machine_id", "=", input.identity.machineId)
        .where("owner_id", "=", input.identity.ownerId)
        .where("runtime_slot", "=", input.identity.runtimeSlot)
        .where("runtime_token_epoch", "=", machine.runtime_token_epoch)
        .where("expires_at", ">", at)
        .whereRef("speech_requests_used", "<", "speech_request_limit")
        .returning("speech_requests_used").executeTakeFirst();
      if (!updated) throw new SpeechFundingError("allowance_exhausted");
      const suffix = createHmac("sha256", options.previewSecret).update([
        input.identity.ownerId, input.identity.machineId, input.identity.runtimeSlot,
        String(machine.runtime_token_epoch), input.requestId,
      ].join("\0")).digest("hex").slice(0, 48);
      return { reservationId: `${PREFIX}${suffix}`, reservedMicrousd: 0 };
    },
    async start(trx, reservationId) {
      if (!reservationId.startsWith(PREFIX)) await options.paid.start(trx, reservationId);
    },
    async settle(trx, reservationId, input) {
      if (!reservationId.startsWith(PREFIX)) await options.paid.settle(trx, reservationId, input);
    },
    async release(trx, reservationId) {
      if (!reservationId.startsWith(PREFIX)) await options.paid.release(trx, reservationId);
    },
  };
}
