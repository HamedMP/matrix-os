import { SlackRuleDefinitionSchema, type CanonicalChatMessage } from "@matrix-os/contracts";
import { SlackChannelMetadataSchema } from "@matrix-os/contracts/slack-bridge";
import { z } from "zod/v4";

const operationLabels = {
  create: "created",
  update: "updated",
  pause: "paused",
  resume: "resumed",
  delete: "deleted",
} as const;

const receiptHeader = /^Slack summary rule (create|update|pause|resume|delete) committed\.(?:\r?\n|$)/;
const receiptSchema = z.object({
  ...SlackRuleDefinitionSchema.shape,
  ruleId: z.string().regex(/^srule_[a-f0-9]{32}$/),
  revision: z.number().int().positive(),
  state: z.enum(["active", "paused", "deleted"]),
  source: z.string().max(81),
  channelId: SlackChannelMetadataSchema.shape.id,
  destination: z.literal("This private Matrix Chat"),
  enabledAfter: z.iso.datetime(),
});
const unavailable = { title: "Slack summary rule details unavailable." };

export interface SlackRuleNotice {
  title: string;
  detail?: string;
}

function readableDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return [minutes ? `${minutes} min` : "", rest ? `${rest} sec` : ""].filter(Boolean).join(" ");
}

/** Only the committed system receipt in the same Chat proves a change. */
export function slackRuleReceiptMessage(message: CanonicalChatMessage, chatId: string | undefined): SlackRuleNotice | undefined {
  const [part] = message.parts;
  if (!chatId || message.chatId !== chatId || message.role !== "system" || message.purpose !== "system"
    || message.state !== "committed" || message.actorId !== undefined || message.turnId !== undefined
    || message.runId !== undefined || message.parts.length !== 1 || part?.type !== "text") return undefined;
  return slackRuleNotice(part.text);
}

function slackRuleNotice(content: string): SlackRuleNotice | undefined {
  const header = receiptHeader.exec(content);
  if (!header) return undefined;
  if (content.length > 16_384) return unavailable;

  let payload: unknown;
  try { payload = JSON.parse(content.slice(header[0].length)); }
  catch (error) {
    if (error instanceof SyntaxError) return unavailable;
    throw error;
  }
  const parsed = receiptSchema.safeParse(payload);
  if (!parsed.success) return unavailable;

  const operation = header[1] as keyof typeof operationLabels;
  const { state, source, channelId, language, trigger, cadence } = parsed.data;
  const expectedState = operation === "pause" ? "paused" : operation === "delete" ? "deleted" : "active";
  if (operation === "update" ? state === "deleted" : state !== expectedState) return unavailable;

  const namedChannel = source.startsWith("#") && SlackChannelMetadataSchema.shape.name.safeParse(source.slice(1)).success;
  if (!namedChannel && source !== channelId) return unavailable;
  const channel = namedChannel ? source : "the enrolled Slack channel";
  const when = trigger === "new_message" ? "Every new message, with or without an @mention." : "Messages that mention you.";
  const timing = cadence.kind === "immediate" ? "right away"
    : `after grouping messages in the same thread for ${readableDuration(cadence.seconds)}`;
  const detail = state === "active" ? `${when} ${language} summaries go to this private Chat ${timing}.`
    : operation === "update" ? "Rule is paused." : undefined;
  return { title: `Slack summary rule ${operationLabels[operation]} for ${channel}.`, detail };
}
