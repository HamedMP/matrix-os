import { z } from "zod/v4";
export const ChatImportSessionSchema = z.object({ runtimeSlot: z.string().min(1).max(128), authGeneration: z.number().int().nonnegative() }).strict();
const Harness = z.enum(["codex", "claude"]);
const count = z.number().int().nonnegative().max(500000);
export const ChatImportPreviewSchema = z.object({ harness: Harness, sourceId: z.uuid(), sourceAgentId: z.string().max(512).optional(), sourceHash: z.string().regex(/^[a-f0-9]{64}$/), rawBytes: z.number().int().min(1).max(20 * 1024 ** 3), title: z.string().max(160), firstVisibleText: z.string().max(500), recordedDirectory: z.string().max(4096).optional(), repositoryUrl: z.string().max(4096).optional(), parserVersion: z.literal(1), counts: z.object({ humanInputs: count, assistantResponses: count, agentInputs: count, toolCalls: count, toolResults: count, attachments: count, externalReferences: count, thinkingRecords: count, contextRecords: count, unknownRecords: count, sourceIssues: count }).strict() }).strict();
const Cancelled = z.object({ status: z.literal("cancelled") }).strict();
const ErrorResult = z.object({ status: z.literal("error"), message: z.string().max(256) }).strict();
export const LOCAL_CHAT_IMPORT_INVOKE = {
    "runtime:chat-import-select": { request: ChatImportSessionSchema.extend({ harness: Harness }), response: z.discriminatedUnion("status", [Cancelled, ErrorResult, z.object({ status: z.literal("selected"), selectionId: z.uuid(), preview: ChatImportPreviewSchema }).strict()]) },
    "runtime:chat-import-apply": { request: ChatImportSessionSchema.extend({ selectionId: z.uuid(), title: z.string().trim().min(1).max(160).regex(/^[^\u0000-\u001f\u007f]+$/) }), response: z.discriminatedUnion("status", [Cancelled, ErrorResult, z.object({ status: z.literal("imported"), jobId: z.uuid(), chatId: z.string().regex(/^chat_[A-Za-z0-9_-]{1,128}$/), messageCount: z.number().int().min(1).max(100000) }).strict()]) },
    "runtime:chat-import-pause": { request: ChatImportSessionSchema, response: z.object({ ok: z.boolean() }).strict() },
} as const;
export const LOCAL_CHAT_IMPORT_EVENTS = { "runtime:chat-import-progress": ChatImportSessionSchema.extend({ selectionId: z.uuid(), phase: z.enum(["uploading", "verifying"]), uploadedBytes: z.number().int().nonnegative().max(20 * 1024 ** 3), totalBytes: z.number().int().min(1).max(20 * 1024 ** 3), jobId: z.uuid() }) } as const;
