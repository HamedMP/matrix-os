import { z } from "zod/v4";
import { KernelEffortSchema, KernelModelSchema } from "./kernel-settings.js";

export const MainWsClientMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("message"),
    text: z.string().trim().min(1).max(100_000),
    displayText: z.string().trim().min(1).max(100_000).optional(),
    sessionId: z.string().min(1).max(256).optional(),
    requestId: z.string().min(1).max(256).optional(),
    model: KernelModelSchema.optional(),
    effort: KernelEffortSchema.optional(),
  }),
  z.object({
    type: z.literal("switch_session"),
    sessionId: z.string().min(1).max(256),
  }),
  z.object({
    type: z.literal("approval_response"),
    id: z.string().min(1).max(256),
    approved: z.boolean(),
  }),
  z.object({
    type: z.literal("ping"),
  }),
  z.object({
    type: z.literal("sync:subscribe"),
    peerId: z.string().min(1).max(128),
    hostname: z.string().max(256),
    platform: z.enum(["darwin", "linux", "win32"]),
    clientVersion: z.string().max(64),
  }),
  z.object({
    type: z.literal("abort"),
    requestId: z.string().min(1).max(256),
  }),
]);

export type MainWsClientMessage = z.infer<typeof MainWsClientMessageSchema>;
