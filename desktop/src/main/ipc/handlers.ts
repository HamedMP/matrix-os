// IPC handler registration. Every request and response is validated against
// the shared contract (FR-081); failures are rejected with generic messages
// and logged with detail on the trusted side only.
import { INVOKE_CHANNELS, type InvokeChannel, type InvokeRequest, type InvokeResponse } from "../../shared/ipc-contract";
import type { AuthService } from "../auth/auth-service";
import type { EmbedService } from "../embeds/embed-service";
import type { LocalStore, LocalStoreKey } from "../persistence/local-store";
import type { UpdateStatus } from "../updates";
import type { DesktopReleaseNotes, DesktopUpdateSnapshot } from "../../shared/desktop-update";
import type { CodingAgentNotificationPreferences, CodingAgentNotificationPreferencesUpdate, CreateAgentThreadRequest, FileBrowseRequest, FileBrowseResponse, FileReadRequest, FileReadResponse, FileSearchRequest, FileSearchResponse, FileWriteRequest, FileWriteResponse, ProjectAgentWorkspace, ReviewSnapshot, ReviewSummary, RuntimeSummary, SourceControlCreatePullRequestRequest, SourceControlCreatePullRequestResponse, SourceControlPrepareCommitRequest, SourceControlPrepareCommitResponse } from "@matrix-os/contracts";
import type { CodingAgentProjectWorkspaceRequest } from "../../shared/coding-agent-project-workspace";
import type { z } from "zod/v4";
import { AgentThreadSnapshotSchema } from "@matrix-os/contracts";
import { clampZoomFactor, DEFAULT_ZOOM_FACTOR } from "../platform/zoom";

interface IpcMainLike {
  handle(
    channel: string,
    listener: (event: unknown, payload: unknown) => Promise<unknown> | unknown,
  ): void;
}

export interface HandlerContext {
  auth: AuthService;
  store: LocalStore;
  embeds: EmbedService;
  openExternal: (url: string) => Promise<void>;
  setBadgeCount: (count: number) => void;
  notify: (input: { threadId: string; title: string; body: string; kind: string }) => void;
  onRuntimeChanged: (slot: string) => void;
  getUpdateStatus: () => UpdateStatus;
  getUpdateSnapshot: () => DesktopUpdateSnapshot;
  installUpdate: () => Promise<boolean> | boolean;
  getWhatsNew: () => Promise<{
    release: DesktopReleaseNotes | null;
    shouldOpen: boolean;
  }>;
  acknowledgeWhatsNew: (version: string) => Promise<void>;
  fetchRuntimeSummary: () => Promise<RuntimeSummary>;
  fetchProjectWorkspace: (
    request: CodingAgentProjectWorkspaceRequest,
  ) => Promise<ProjectAgentWorkspace>;
  fetchNotificationPreferences: () => Promise<CodingAgentNotificationPreferences>;
  updateNotificationPreferences: (
    request: CodingAgentNotificationPreferencesUpdate,
  ) => Promise<CodingAgentNotificationPreferences>;
  fetchHermesConfiguration: () => Promise<InvokeResponse<"runtime:get-hermes-configuration">>;
  fetchHermesEnvironment: () => Promise<InvokeResponse<"runtime:get-hermes-environment">>;
  updateHermesConfiguration: (
    request: InvokeRequest<"runtime:update-hermes-configuration">,
  ) => Promise<InvokeResponse<"runtime:update-hermes-configuration">>;
  setHermesCredential: (
    request: InvokeRequest<"runtime:set-hermes-credential">,
  ) => Promise<InvokeResponse<"runtime:set-hermes-credential">>;
  removeHermesCredential: (
    request: InvokeRequest<"runtime:remove-hermes-credential">,
  ) => Promise<InvokeResponse<"runtime:remove-hermes-credential">>;
  fetchReviewSummaries: (
    options: { cursor?: string },
  ) => Promise<{ items: ReviewSummary[]; hasMore: boolean; limit: number; nextCursor?: string }>;
  fetchReviewSnapshot: (options: { reviewId: string }) => Promise<ReviewSnapshot>;
  fetchFileBrowse: (request: FileBrowseRequest) => Promise<FileBrowseResponse>;
  fetchFileSearch: (request: FileSearchRequest) => Promise<FileSearchResponse>;
  fetchFileContent: (request: FileReadRequest) => Promise<FileReadResponse>;
  saveFileContent: (request: FileWriteRequest) => Promise<FileWriteResponse>;
  prepareSourceCommit: (
    request: SourceControlPrepareCommitRequest,
  ) => Promise<SourceControlPrepareCommitResponse>;
  createSourcePullRequest: (
    request: SourceControlCreatePullRequestRequest,
  ) => Promise<SourceControlCreatePullRequestResponse>;
  fetchThreadSnapshot: (
    options: { threadId: string },
  ) => Promise<z.infer<typeof AgentThreadSnapshotSchema>>;
  submitApprovalDecision: (
    request: InvokeRequest<"runtime:submit-approval-decision">,
  ) => Promise<z.infer<typeof AgentThreadSnapshotSchema>>;
  submitInputAnswer: (
    request: InvokeRequest<"runtime:submit-input-answer">,
  ) => Promise<z.infer<typeof AgentThreadSnapshotSchema>>;
  createAgentThread: (
    request: CreateAgentThreadRequest,
  ) => Promise<z.infer<typeof AgentThreadSnapshotSchema>>;
  createAgentTurn: (
    request: InvokeRequest<"runtime:create-turn">,
  ) => Promise<InvokeResponse<"runtime:create-turn">>;
  abortAgentThread: (
    request: InvokeRequest<"runtime:abort-thread">,
  ) => Promise<InvokeResponse<"runtime:abort-thread">>;
  subscribeThreadEvents: (
    request: InvokeRequest<"runtime:subscribe-thread-events">,
  ) => Promise<void>;
  unsubscribeThreadEvents: (
    request: InvokeRequest<"runtime:unsubscribe-thread-events">,
  ) => void;
}

type Handler<C extends InvokeChannel> = (
  payload: InvokeRequest<C>,
  event: unknown,
) => Promise<InvokeResponse<C>> | InvokeResponse<C>;

const PUBLIC_IPC_ERRORS = new Set(["invalid request", "internal error", "embed unavailable"]);

// The sender's webContents is the only zoom target; anything else (tests,
// malformed events) degrades to a no-op instead of throwing.
interface ZoomTarget {
  getZoomFactor(): number;
  setZoomFactor(factor: number): void;
}

function zoomTarget(event: unknown): ZoomTarget | null {
  const sender = (event as { sender?: Partial<ZoomTarget> } | null)?.sender;
  if (
    sender &&
    typeof sender.getZoomFactor === "function" &&
    typeof sender.setZoomFactor === "function"
  ) {
    return sender as ZoomTarget;
  }
  return null;
}

function toWebContentsViewBounds(
  bounds: InvokeRequest<"embed:set-bounds">["bounds"],
  event: unknown,
): InvokeRequest<"embed:set-bounds">["bounds"] {
  const factor = clampZoomFactor(
    zoomTarget(event)?.getZoomFactor() ?? DEFAULT_ZOOM_FACTOR,
  );
  return {
    x: Math.round(bounds.x * factor),
    y: Math.round(bounds.y * factor),
    width: Math.round(bounds.width * factor),
    height: Math.round(bounds.height * factor),
  };
}

export function registerIpcHandlers(ipcMain: IpcMainLike, ctx: HandlerContext): void {
  function handle<C extends InvokeChannel>(channel: C, handler: Handler<C>): void {
    ipcMain.handle(channel, async (_event, rawPayload) => {
      const parsedRequest = INVOKE_CHANNELS[channel].request.safeParse(rawPayload ?? {});
      if (!parsedRequest.success) {
        console.warn(`[ipc] rejected malformed request on ${channel}`);
        throw new Error("invalid request");
      }
      let result: InvokeResponse<C>;
      try {
        result = await handler(parsedRequest.data as InvokeRequest<C>, _event);
      } catch (err: unknown) {
        console.warn(
          `[ipc] handler for ${channel} failed:`,
          err instanceof Error ? err.message : String(err),
        );
        if (err instanceof Error && PUBLIC_IPC_ERRORS.has(err.message)) {
          throw err;
        }
        throw new Error("internal error");
      }
      const parsedResponse = INVOKE_CHANNELS[channel].response.safeParse(result);
      if (!parsedResponse.success) {
        console.warn(`[ipc] handler for ${channel} produced an invalid response`);
        throw new Error("internal error");
      }
      return parsedResponse.data;
    });
  }

  handle("auth:start-device-flow", () => ctx.auth.startDeviceFlow());
  handle("auth:poll", () => ctx.auth.poll());
  handle("auth:status", () => ctx.auth.getStatus());
  handle("auth:sign-out", async () => {
    await ctx.auth.signOut();
    return { ok: true };
  });
  handle("auth:session-expired", async () => {
    await ctx.auth.expireSession();
    return { ok: true };
  });

  handle("runtime:list-computers", () => ctx.auth.listRuntimeComputers());
  handle("runtime:select", async ({ slot }) => {
    await ctx.auth.selectRuntime(slot);
    ctx.onRuntimeChanged(slot);
    return { ok: true };
  });
  handle("runtime:get-summary", () => ctx.fetchRuntimeSummary());
  handle("runtime:get-project-workspace", (request) => ctx.fetchProjectWorkspace(request));
  handle("runtime:get-notification-preferences", () => ctx.fetchNotificationPreferences());
  handle("runtime:update-notification-preferences", (request) => ctx.updateNotificationPreferences(request));
  handle("runtime:get-hermes-configuration", () => ctx.fetchHermesConfiguration());
  handle("runtime:get-hermes-environment", () => ctx.fetchHermesEnvironment());
  handle("runtime:update-hermes-configuration", (request) => ctx.updateHermesConfiguration(request));
  handle("runtime:set-hermes-credential", (request) => ctx.setHermesCredential(request));
  handle("runtime:remove-hermes-credential", (request) => ctx.removeHermesCredential(request));
  handle("runtime:get-reviews", (request) => ctx.fetchReviewSummaries(request));
  handle("runtime:get-review-snapshot", (request) => ctx.fetchReviewSnapshot(request));
  handle("runtime:browse-files", (request) => ctx.fetchFileBrowse(request));
  handle("runtime:search-files", (request) => ctx.fetchFileSearch(request));
  handle("runtime:get-file-content", (request) => ctx.fetchFileContent(request));
  handle("runtime:save-file-content", (request) => ctx.saveFileContent(request));
  handle("runtime:prepare-source-commit", (request) => ctx.prepareSourceCommit(request));
  handle("runtime:create-source-pull-request", (request) => ctx.createSourcePullRequest(request));
  handle("runtime:get-thread-snapshot", (request) => ctx.fetchThreadSnapshot(request));
  handle("runtime:subscribe-thread-events", async (request) => {
    await ctx.subscribeThreadEvents(request);
    return { ok: true };
  });
  handle("runtime:unsubscribe-thread-events", (request) => {
    ctx.unsubscribeThreadEvents(request);
    return { ok: true };
  });
  handle("runtime:submit-approval-decision", (request) => ctx.submitApprovalDecision(request));
  handle("runtime:submit-input-answer", (request) => ctx.submitInputAnswer(request));
  handle("runtime:create-thread", (request) => ctx.createAgentThread(request));
  handle("runtime:create-turn", (request) => ctx.createAgentTurn(request));
  handle("runtime:abort-thread", (request) => ctx.abortAgentThread(request));

  // The renderer appearance store owns the persisted factor; these handlers
  // only apply/read it on the sender's webContents.
  handle("app:get-zoom", (_payload, event) => {
    const target = zoomTarget(event);
    return { factor: target ? clampZoomFactor(target.getZoomFactor()) : DEFAULT_ZOOM_FACTOR };
  });
  handle("app:set-zoom", ({ factor }, event) => {
    zoomTarget(event)?.setZoomFactor(factor);
    return { factor };
  });

  handle("state:get", async ({ key }) => ({
    value: await ctx.store.get(key as LocalStoreKey),
  }));
  handle("state:set", async ({ key, value }) => {
    try {
      await ctx.store.setUnknown(key as LocalStoreKey, value);
    } catch (err: unknown) {
      console.warn(
        `[ipc] state:set rejected for key ${key}:`,
        err instanceof Error ? err.message : String(err),
      );
      throw new Error("invalid request");
    }
    return { ok: true };
  });
  handle("state:set-panel-layout", async ({ taskKey, layout }) => {
    try {
      await ctx.store.setPanelLayout(taskKey, layout);
    } catch (err: unknown) {
      console.warn(
        "[ipc] state:set-panel-layout rejected:",
        err instanceof Error ? err.message : String(err),
      );
      throw new Error("invalid request");
    }
    return { ok: true };
  });

  handle("shell:open-external", async ({ url }) => {
    await ctx.openExternal(url);
    return { ok: true };
  });

  handle("badge:set", ({ count }) => {
    ctx.setBadgeCount(count);
    return { ok: true };
  });

  handle("notify", (payload) => {
    ctx.notify(payload);
    return { ok: true };
  });

  handle("embed:open", async ({ kind, slug, bounds, active }, event) => {
    try {
      return await ctx.embeds.open({
        kind,
        slug,
        bounds: toWebContentsViewBounds(bounds, event),
        active,
      });
    } catch (err: unknown) {
      console.warn(
        "[ipc] embed:open failed:",
        err instanceof Error ? err.message : String(err),
      );
      throw new Error("embed unavailable");
    }
  });
  handle("embed:set-bounds", ({ embedId, bounds }, event) => ({
    ok: ctx.embeds.setBounds(embedId, toWebContentsViewBounds(bounds, event)),
  }));
  handle("embed:set-active", ({ embedId, active }) => ({
    ok: ctx.embeds.setActive(embedId, active),
  }));
  handle("embed:reload", ({ embedId }) => ({ ok: ctx.embeds.reload(embedId) }));
  handle("embed:close", ({ embedId }) => ({ ok: ctx.embeds.close(embedId) }));
  handle("embed:retry-auth", async ({ embedId }) => {
    try {
      return { ok: await ctx.embeds.retryAuth(embedId) };
    } catch (err: unknown) {
      console.warn(
        "[ipc] embed:retry-auth failed:",
        err instanceof Error ? err.message : String(err),
      );
      return { ok: false };
    }
  });

  handle("update:check", () => ({ status: ctx.getUpdateStatus() }));
  handle("update:get-state", () => ctx.getUpdateSnapshot());
  handle("update:install", async () => ({ ok: await ctx.installUpdate() }));
  handle("update:get-whats-new", () => ctx.getWhatsNew());
  handle("update:acknowledge-whats-new", async ({ version }) => {
    await ctx.acknowledgeWhatsNew(version);
    return { ok: true };
  });
}
