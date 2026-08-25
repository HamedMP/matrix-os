// Single source of truth for the renderer ↔ trusted-core IPC contract
// (specs/094-electron-macos-shell/contracts/ipc-contract.md). Both main and
// preload import this module; every channel is validated on both sides
// (FR-081). The bearer credential never appears in any schema; Hermes provider
// credentials are accepted only by the bounded write-only setter request.
import { z } from "zod/v4";
import {
  ApprovalDecisionRequestSchema,
  ApprovalIdSchema,
  AgentThreadEventSchema,
  AgentThreadSnapshotSchema,
  CodingAgentNotificationPreferencesSchema,
  CodingAgentNotificationPreferencesUpdateSchema,
  CreateAgentThreadRequestSchema,
  CreateAgentTurnErrorSchema,
  CreateAgentTurnRequestSchema,
  CreateAgentTurnResponseSchema,
  CursorSchema,
  FileBrowseRequestSchema,
  FileBrowseResponseSchema,
  FileReadRequestSchema,
  FileReadResponseSchema,
  FileSearchRequestSchema,
  FileSearchResponseSchema,
  FileWriteRequestSchema,
  FileWriteResponseSchema,
  HermesConfigurationChangeRequestSchema,
  HermesConfigurationSchema,
  HermesCredentialRemoveRequestSchema,
  HermesCredentialSetRequestSchema,
  HermesEnvironmentSchema,
  ProjectAgentWorkspaceSchema,
  ReviewSnapshotSchema,
  ReviewSummarySchema,
  MatrixComputerListSchema,
  RuntimeSelectionRequestSchema,
  RuntimeSummarySchema,
  SafeClientErrorSchema,
  SourceControlCreatePullRequestRequestSchema,
  SourceControlCreatePullRequestResponseSchema,
  SourceControlPrepareCommitRequestSchema,
  SourceControlPrepareCommitResponseSchema,
  ThreadIdSchema,
  RequestIdSchema,
  UserInputAnswerRequestSchema,
  boundedListSchema,
} from "@matrix-os/contracts";
import { CodingAgentProjectWorkspaceRequestSchema } from "./coding-agent-project-workspace";
import {
  DesktopReleaseNotesSchema,
  DesktopUpdateSnapshotSchema,
  DesktopUpdateVersionSchema,
} from "./desktop-update";

const Empty = z.object({}).strict();

const Ok = z.object({ ok: z.boolean() }).strict();
const HermesOk = z.object({ ok: z.literal(true) }).strict();
const CodingAgentCreateTurnRequestSchema = CreateAgentTurnRequestSchema.extend({
  threadId: ThreadIdSchema,
}).strict();
const CodingAgentCreateTurnResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), response: CreateAgentTurnResponseSchema }).strict(),
  z.object({ ok: z.literal(false), error: CreateAgentTurnErrorSchema }).strict(),
]);
const EmbedStateSchema = z.enum(["loading", "ready", "auth-required", "failed"]);
const ReviewIdSchema = z.string().regex(/^rev_[A-Za-z0-9_-]{1,128}$/);

// App-wide Chromium zoom factor (webContents.setZoomFactor). Bounded so a
// renderer can never push the UI outside the supported 50%–200% range.
const ZoomFactorSchema = z.number().min(0.5).max(2);
const ZoomFactorResultSchema = z.object({ factor: ZoomFactorSchema }).strict();
const CompanionPromptSchema = z.string().trim().min(1).max(4_000);

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
  "desktopShell",
  "terminalAppearance",
  "recents",
  "projectViews",
  "providerPreferences",
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
        authGeneration: z.number().int().nonnegative(),
      })
      .strict(),
  },
  "auth:sign-out": { request: Empty, response: Ok },
  "auth:session-expired": { request: Empty, response: Ok },
  "runtime:list-computers": {
    request: Empty,
    response: MatrixComputerListSchema,
  },
  "runtime:select": {
    request: RuntimeSelectionRequestSchema,
    response: Ok,
  },
  "runtime:get-summary": {
    request: Empty,
    response: RuntimeSummarySchema,
  },
  "runtime:get-project-workspace": {
    request: CodingAgentProjectWorkspaceRequestSchema,
    response: ProjectAgentWorkspaceSchema,
  },
  "runtime:get-notification-preferences": {
    request: Empty,
    response: CodingAgentNotificationPreferencesSchema,
  },
  "runtime:update-notification-preferences": {
    request: CodingAgentNotificationPreferencesUpdateSchema,
    response: CodingAgentNotificationPreferencesSchema,
  },
  "runtime:get-hermes-configuration": {
    request: Empty,
    response: HermesConfigurationSchema,
  },
  "runtime:get-hermes-environment": {
    request: Empty,
    response: HermesEnvironmentSchema,
  },
  "runtime:update-hermes-configuration": {
    request: HermesConfigurationChangeRequestSchema,
    response: HermesOk,
  },
  "runtime:set-hermes-credential": {
    request: HermesCredentialSetRequestSchema,
    response: HermesOk,
  },
  "runtime:remove-hermes-credential": {
    request: HermesCredentialRemoveRequestSchema,
    response: HermesOk,
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
  "runtime:subscribe-thread-events": {
    request: z.object({ threadId: ThreadIdSchema, cursor: CursorSchema.optional() }).strict(),
    response: Ok,
  },
  "runtime:unsubscribe-thread-events": {
    request: z.object({ threadId: ThreadIdSchema }).strict(),
    response: Ok,
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
    request: UserInputAnswerRequestSchema.safeExtend({
      threadId: ThreadIdSchema,
      inputRequestId: RequestIdSchema,
    }),
    response: AgentThreadSnapshotSchema,
  },
  "runtime:create-thread": {
    request: CreateAgentThreadRequestSchema,
    response: AgentThreadSnapshotSchema,
  },
  "runtime:create-turn": {
    request: CodingAgentCreateTurnRequestSchema,
    response: CodingAgentCreateTurnResultSchema,
  },
  // Aborts one running thread. The gateway returns the authoritative aborted
  // snapshot, so the renderer can settle the conversation even when the event
  // stream is disconnected. The clientRequestId is minted in the main process
  // so it always satisfies RequestIdSchema's req_ prefix.
  "runtime:abort-thread": {
    request: z.object({ threadId: ThreadIdSchema }).strict(),
    response: AgentThreadSnapshotSchema,
  },
  // App-wide UI zoom: the renderer owns the persisted factor; main applies it
  // to the sender's webContents and reports menu-driven steps back via the
  // app:zoom-changed event.
  "app:get-zoom": { request: Empty, response: ZoomFactorResultSchema },
  "app:set-zoom": {
    request: ZoomFactorResultSchema,
    response: ZoomFactorResultSchema,
  },
  "companion:set-expanded": {
    request: z.strictObject({ expanded: z.boolean() }),
    response: Ok,
  },
  "companion:renderer-ready": { request: Empty, response: Ok },
  "companion:focus-main": { request: Empty, response: Ok },
  "companion:hide": { request: Empty, response: Ok },
  "companion:submit-prompt": {
    request: z.strictObject({ prompt: CompanionPromptSchema }),
    response: Ok,
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
    request: z.strictObject({
      kind: z.enum(["hosted-shell", "app"]),
      slug: z.string().min(1).max(128).optional(),
      appIdentity: z.string().min(1).max(256)
        .regex(/^[a-z0-9][a-z0-9_-]*(?:\/[a-z0-9][a-z0-9_-]*)*$/)
        .optional(),
      bounds: BoundsSchema,
      active: z.boolean().optional(),
    }),
    response: z.object({ embedId: z.string().min(1).max(64), state: EmbedStateSchema }).strict(),
  },
  "embed:set-bounds": {
    request: z
      .object({ embedId: z.string().min(1).max(64), bounds: BoundsSchema })
      .strict(),
    response: Ok,
  },
  "embed:set-scale": {
    request: z.strictObject({ embedId: z.string().min(1).max(64), factor: ZoomFactorSchema }),
    response: Ok,
  },
  "embed:set-active": {
    request: z.object({ embedId: z.string().min(1).max(64), active: z.boolean() }).strict(),
    response: Ok,
  },
  "embed:suspend-all": {
    request: Empty,
    response: Ok,
  },
  "embed:reload": {
    request: z.object({ embedId: z.string().min(1).max(64) }).strict(),
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
    response: DesktopUpdateSnapshotSchema,
  },
  "update:get-state": {
    request: Empty,
    response: DesktopUpdateSnapshotSchema,
  },
  "update:install": {
    request: Empty,
    response: Ok,
  },
  "update:get-whats-new": {
    request: Empty,
    response: z
      .object({
        release: DesktopReleaseNotesSchema.nullable(),
        shouldOpen: z.boolean(),
      })
      .strict(),
  },
  "update:acknowledge-whats-new": {
    request: z.object({ version: DesktopUpdateVersionSchema }).strict(),
    response: Ok,
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
  "runtime:thread-event": z.object({
    threadId: ThreadIdSchema,
    event: AgentThreadEventSchema,
  }).strict(),
  "runtime:thread-stream-error": z.object({
    threadId: ThreadIdSchema,
    error: SafeClientErrorSchema,
  }).strict(),
  "update:available": z.object({ version: z.string().max(64) }).strict(),
  "update:ready": z.object({ version: z.string().max(64) }).strict(),
  "update:manual-check-requested": z.strictObject({}),
  "update:state-changed": DesktopUpdateSnapshotSchema,
  "window:focus-changed": z.object({ focused: z.boolean() }).strict(),
  "companion:prompt-requested": z.strictObject({ prompt: CompanionPromptSchema }),
  "app:zoom-changed": ZoomFactorResultSchema,
  "menu:action": z
    .object({ action: z.enum(["new-task", "new-thread", "palette", "quick-open", "refresh-home"]) })
    .strict(),
  "menu:navigate": z.object({ kind: z.enum(["settings", "board", "project", "terminals"]) }).strict(),
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
