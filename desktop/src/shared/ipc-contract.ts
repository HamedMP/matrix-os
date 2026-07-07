// Single source of truth for the renderer ↔ trusted-core IPC contract
// (specs/094-electron-macos-shell/contracts/ipc-contract.md). Both main and
// preload import this module; every channel is validated on both sides
// (FR-081). The credential never appears in any schema.
import { z } from "zod/v4";
import {
  ApprovalDecisionRequestSchema,
  ApprovalIdSchema,
  AgentThreadSnapshotSchema,
  CodingAgentNotificationPreferencesSchema,
  CodingAgentNotificationPreferencesUpdateSchema,
  CreateAgentThreadRequestSchema,
  CursorSchema,
  FileBrowseRequestSchema,
  FileBrowseResponseSchema,
  FileReadRequestSchema,
  FileReadResponseSchema,
  FileSearchRequestSchema,
  FileSearchResponseSchema,
  FileWriteRequestSchema,
  FileWriteResponseSchema,
  ReviewSnapshotSchema,
  ReviewSummarySchema,
  RuntimeSummarySchema,
  SourceControlCreatePullRequestRequestSchema,
  SourceControlCreatePullRequestResponseSchema,
  SourceControlPrepareCommitRequestSchema,
  SourceControlPrepareCommitResponseSchema,
  ThreadIdSchema,
  RequestIdSchema,
  UserInputAnswerRequestSchema,
  boundedListSchema,
} from "@matrix-os/contracts";

const Empty = z.object({}).strict();

const Ok = z.object({ ok: z.boolean() }).strict();
const EmbedStateSchema = z.enum(["loading", "ready", "auth-required", "failed"]);
const ReviewIdSchema = z.string().regex(/^rev_[A-Za-z0-9_-]{1,128}$/);

const ProfileSchema = z
  .object({
    handle: z.string().min(1).max(64),
    userId: z.string().min(1).max(128),
  })
  .strict();

const BoundsSchema = z
  .object({
    x: z.number().int().min(-16_384).max(16_384),
    y: z.number().int().min(-16_384).max(16_384),
    width: z.number().int().min(0).max(16_384),
    height: z.number().int().min(0).max(16_384),
  })
  .strict();

const PanelLayoutSchema = z
  .object({
    order: z.array(z.string().max(32)).max(12),
    visible: z.record(z.string().max(32), z.boolean()),
    sizes: z.record(z.string().max(32), z.number().min(0).max(100)),
    touchedAt: z.number().int().nonnegative(),
  })
  .strict();

const STATE_KEYS = [
  "windowBounds",
  "lastProjectSlug",
  "panelLayouts",
  "appearance",
  "recents",
] as const;

const MAX_STATE_VALUE_BYTES = 64 * 1024;

const BoundedJsonValue = z.unknown().refine(
  (value) => {
    try {
      return JSON.stringify(value).length <= MAX_STATE_VALUE_BYTES;
    } catch {
      return false;
    }
  },
  { message: "state value too large" },
);

export const INVOKE_CHANNELS = {
  "auth:start-device-flow": {
    request: Empty,
    response: z
      .object({
        userCode: z.string().min(1).max(32),
        verificationUri: z.string().max(512),
        expiresIn: z.number().int().positive(),
      })
      .strict(),
  },
  "auth:poll": {
    request: Empty,
    response: z
      .object({
        status: z.enum(["pending", "authorized", "expired"]),
        profile: ProfileSchema.optional(),
      })
      .strict(),
  },
  "auth:status": {
    request: Empty,
    response: z
      .object({
        signedIn: z.boolean(),
        handle: z.string().max(64).optional(),
        displayName: z.string().max(256).optional(),
        imageUrl: z.string().url().max(2048).optional(),
        runtimeSlot: z.string().max(64),
        platformHost: z.string().max(256),
      })
      .strict(),
  },
  "auth:sign-out": { request: Empty, response: Ok },
  "auth:session-expired": { request: Empty, response: Ok },
  "runtime:select": {
    request: z.object({ slot: z.string().min(1).max(64) }).strict(),
    response: Ok,
  },
  "runtime:get-summary": {
    request: Empty,
    response: RuntimeSummarySchema,
  },
  "runtime:get-notification-preferences": {
    request: Empty,
    response: CodingAgentNotificationPreferencesSchema,
  },
  "runtime:update-notification-preferences": {
    request: CodingAgentNotificationPreferencesUpdateSchema,
    response: CodingAgentNotificationPreferencesSchema,
  },
  "runtime:get-reviews": {
    request: z.object({ cursor: CursorSchema.optional() }).strict(),
    response: boundedListSchema(ReviewSummarySchema, 50),
  },
  "runtime:get-review-snapshot": {
    request: z.object({ reviewId: ReviewIdSchema }).strict(),
    response: ReviewSnapshotSchema,
  },
  "runtime:browse-files": {
    request: FileBrowseRequestSchema,
    response: FileBrowseResponseSchema,
  },
  "runtime:search-files": {
    request: FileSearchRequestSchema,
    response: FileSearchResponseSchema,
  },
  "runtime:get-file-content": {
    request: FileReadRequestSchema,
    response: FileReadResponseSchema,
  },
  "runtime:save-file-content": {
    request: FileWriteRequestSchema,
    response: FileWriteResponseSchema,
  },
  "runtime:prepare-source-commit": {
    request: SourceControlPrepareCommitRequestSchema,
    response: SourceControlPrepareCommitResponseSchema,
  },
  "runtime:create-source-pull-request": {
    request: SourceControlCreatePullRequestRequestSchema,
    response: SourceControlCreatePullRequestResponseSchema,
  },
  "runtime:get-thread-snapshot": {
    request: z.object({ threadId: ThreadIdSchema }).strict(),
    response: AgentThreadSnapshotSchema,
  },
  "runtime:submit-approval-decision": {
    request: z
      .object({
        threadId: ThreadIdSchema,
        approvalId: ApprovalIdSchema,
      })
      .extend(ApprovalDecisionRequestSchema.shape)
      .strict(),
    response: AgentThreadSnapshotSchema,
  },
  "runtime:submit-input-answer": {
    request: z
      .object({
        threadId: ThreadIdSchema,
        inputRequestId: RequestIdSchema,
      })
      .extend(UserInputAnswerRequestSchema.shape)
      .strict(),
    response: AgentThreadSnapshotSchema,
  },
  "runtime:create-thread": {
    request: CreateAgentThreadRequestSchema,
    response: AgentThreadSnapshotSchema,
  },
  "state:get": {
    request: z.object({ key: z.enum(STATE_KEYS) }).strict(),
    response: z.object({ value: z.unknown() }).strict(),
  },
  "state:set": {
    request: z
      .object({ key: z.enum(STATE_KEYS), value: BoundedJsonValue })
      .strict(),
    response: Ok,
  },
  "state:set-panel-layout": {
    request: z
      .object({ taskKey: z.string().min(1).max(256), layout: PanelLayoutSchema })
      .strict(),
    response: Ok,
  },
  "embed:open": {
    request: z
      .object({
        kind: z.enum(["hosted-shell", "app"]),
        slug: z.string().min(1).max(128).optional(),
        bounds: BoundsSchema,
        active: z.boolean().optional(),
      })
      .strict(),
    response: z.object({ embedId: z.string().min(1).max(64), state: EmbedStateSchema }).strict(),
  },
  "embed:set-bounds": {
    request: z
      .object({ embedId: z.string().min(1).max(64), bounds: BoundsSchema })
      .strict(),
    response: Ok,
  },
  "embed:set-active": {
    request: z.object({ embedId: z.string().min(1).max(64), active: z.boolean() }).strict(),
    response: Ok,
  },
  "embed:close": {
    request: z.object({ embedId: z.string().min(1).max(64) }).strict(),
    response: Ok,
  },
  "embed:retry-auth": {
    request: z.object({ embedId: z.string().min(1).max(64) }).strict(),
    response: Ok,
  },
  notify: {
    request: z
      .object({
        threadId: z.string().min(1).max(128),
        title: z.string().min(1).max(80),
        body: z.string().max(200),
        kind: z.enum(["done", "failed", "attention", "connection"]),
      })
      .strict(),
    response: Ok,
  },
  "badge:set": {
    request: z.object({ count: z.number().int().min(0).max(999) }).strict(),
    response: Ok,
  },
  "shell:open-external": {
    request: z
      .object({
        url: z
          .string()
          .max(2048)
          .refine((value) => {
            try {
              return new URL(value).protocol === "https:";
            } catch {
              return false;
            }
          }, "https urls only"),
      })
      .strict(),
    response: Ok,
  },
  "update:check": {
    request: Empty,
    response: z
      .object({ status: z.enum(["disabled", "checking", "up-to-date", "downloading", "ready", "error"]) })
      .strict(),
  },
} as const;

export const EVENT_CHANNELS = {
  "auth:changed": z
    .object({
      signedIn: z.boolean(),
      handle: z.string().max(64).optional(),
      displayName: z.string().max(256).optional(),
      imageUrl: z.string().url().max(2048).optional(),
    })
    .strict(),
  "runtime:changed": z.object({ slot: z.string().min(1).max(64) }).strict(),
  "embed:state": z
    .object({
      embedId: z.string().min(1).max(64),
      state: EmbedStateSchema,
    })
    .strict(),
  "notification:clicked": z.object({ threadId: z.string().min(1).max(128) }).strict(),
  "update:available": z.object({ version: z.string().max(64) }).strict(),
  "update:ready": z.object({ version: z.string().max(64) }).strict(),
  "window:focus-changed": z.object({ focused: z.boolean() }).strict(),
  "menu:action": z
    .object({ action: z.enum(["new-task", "new-thread", "palette", "quick-open"]) })
    .strict(),
  "menu:navigate": z.object({ kind: z.enum(["settings", "board"]) }).strict(),
} as const;

export type InvokeChannel = keyof typeof INVOKE_CHANNELS;
export type EventChannel = keyof typeof EVENT_CHANNELS;

export type InvokeRequest<C extends InvokeChannel> = z.infer<
  (typeof INVOKE_CHANNELS)[C]["request"]
>;
export type InvokeResponse<C extends InvokeChannel> = z.infer<
  (typeof INVOKE_CHANNELS)[C]["response"]
>;
export type EventPayload<C extends EventChannel> = z.infer<(typeof EVENT_CHANNELS)[C]>;
