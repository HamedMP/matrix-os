import { SlackBridgeEnvelopeSchema, type SlackBridgeEnvelope } from "@matrix-os/contracts/slack-bridge";
export const SlackHomeEnvelopeSchema = SlackBridgeEnvelopeSchema;
export const SlackEventSchema = SlackBridgeEnvelopeSchema.shape.event;
export type SlackHomeEnvelope = SlackBridgeEnvelope;
export interface SlackThreadBinding { scopeId: string; chatId: string; projectScopeId: string; projectId: string }
export class SlackCompanyError extends Error {
  constructor(readonly code: "forbidden" | "unavailable" | "conflict" | "capacity") {
    super("Slack company request unavailable"); this.name = "SlackCompanyError";
  }
}
