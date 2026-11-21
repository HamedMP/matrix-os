import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  SlackEnrolledEventSourceSchema, type SlackEnrolledEventAttestation, type SlackEnrolledEventSource,
} from "@matrix-os/contracts/slack-bridge";
import { slackContextGrantId } from "./mention-summary.js";
import type { SlackThreadContextGrant } from "./thread-context.js";

type EventIdentity = Pick<SlackEnrolledEventSource, "eventId" | "threadTs" | "ts" | "userId">;

function sourceProof(secret: string, grant: SlackThreadContextGrant, source: Omit<SlackEnrolledEventSource, "proof">): string {
  return createHmac("sha256", secret).update("matrix-slack-enrolled-source-v1\n")
    .update(JSON.stringify([slackContextGrantId(grant), source.version, grant.appId, grant.teamId, grant.channelId,
      source.eventId, source.threadTs, source.ts, source.userId, source.textDigest, source.ownerMention])).digest("hex");
}

export function attestSlackEnrolledEvent(secret: string, grant: SlackThreadContextGrant, event: EventIdentity & { text: string }, ownerMention: boolean): SlackEnrolledEventAttestation {
  const source = {
    version: 1 as const, ownerMention,
    eventId: event.eventId, threadTs: event.threadTs, ts: event.ts, userId: event.userId,
    textDigest: createHash("sha256").update(event.text, "utf8").digest("hex"),
  };
  return { version: source.version, ownerMention, textDigest: source.textDigest, proof: sourceProof(secret, grant, source) };
}

export function validSlackEnrolledSource(secret: string, grant: SlackThreadContextGrant, value: unknown): boolean {
  const source = SlackEnrolledEventSourceSchema.safeParse(value);
  if (!source.success || (grant.scope !== "channel" && source.data.threadTs !== grant.threadTs)
    || (source.data.ownerMention && source.data.userId === grant.ownerSlackId)) return false;
  const expected = sourceProof(secret, grant, source.data);
  return timingSafeEqual(Buffer.from(source.data.proof, "hex"), Buffer.from(expected, "hex"));
}
