import { z } from "zod/v4";

/** Full replacement; revision is the base revision on PUT and the committed revision on GET. */
export const NotificationPreferencesSchema = z.object({
  version: z.literal(1),
  revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  events: z.object({
    approval: z.boolean(),
    question: z.boolean(),
    replyFinished: z.boolean(),
    runFailed: z.boolean(),
    minReplySeconds: z.union([z.literal(0), z.literal(10), z.literal(30), z.literal(60), z.literal(300)]),
  }).strict(),
  phone: z.object({
    mode: z.enum(["when_away", "always", "never"]),
    awayAfterSeconds: z.union([z.literal(60), z.literal(180), z.literal(300), z.literal(600), z.literal(900)]),
    replyDelaySeconds: z.union([z.literal(0), z.literal(30), z.literal(60), z.literal(120), z.literal(300)]),
  }).strict(),
  content: z.object({
    showPreview: z.boolean(),
    sound: z.boolean(),
    timeSensitive: z.boolean(),
  }).strict(),
}).strict();

export type NotificationPreferences = z.infer<typeof NotificationPreferencesSchema>;

export const DEFAULT_NOTIFICATION_PREFERENCES: Readonly<NotificationPreferences> = Object.freeze({
  version: 1,
  revision: 0,
  events: Object.freeze({ approval: true, question: true, replyFinished: true, runFailed: true, minReplySeconds: 10 }),
  phone: Object.freeze({ mode: "when_away", awayAfterSeconds: 180, replyDelaySeconds: 60 }),
  content: Object.freeze({ showPreview: false, sound: true, timeSensitive: false }),
});

export const CodingAgentAttentionNotificationKindSchema = z.enum(["approval", "input", "failed", "completed"]);

export const CodingAgentNotificationPreferencesSchema = z.object({
  attentionPush: z.object({
    approval: z.boolean(),
    input: z.boolean(),
    failed: z.boolean(),
    completed: z.boolean().default(true),
  }).strict(),
}).strict();

export const CodingAgentNotificationPreferencesUpdateSchema = CodingAgentNotificationPreferencesSchema;

export type CodingAgentAttentionNotificationKind =
  z.infer<typeof CodingAgentAttentionNotificationKindSchema>;
export type CodingAgentNotificationPreferences =
  z.infer<typeof CodingAgentNotificationPreferencesSchema>;
export type CodingAgentNotificationPreferencesUpdate =
  z.infer<typeof CodingAgentNotificationPreferencesUpdateSchema>;
