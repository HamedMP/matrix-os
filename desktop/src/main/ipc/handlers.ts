// IPC handler registration. Every request and response is validated against
// the shared contract (FR-081); failures are rejected with generic messages
// and logged with detail on the trusted side only.
import { INVOKE_CHANNELS, type InvokeChannel, type InvokeRequest, type InvokeResponse } from "../../shared/ipc-contract";
import type { AuthService } from "../auth/auth-service";
import type { EmbedService } from "../embeds/embed-service";
import type { LocalStore, LocalStoreKey } from "../persistence/local-store";
import type { UpdateStatus } from "../updates";
import type { CreateAgentThreadRequest, FileBrowseRequest, FileBrowseResponse, FileReadRequest, FileReadResponse, FileSearchRequest, FileSearchResponse, FileWriteRequest, FileWriteResponse, ReviewSnapshot, ReviewSummary, RuntimeSummary, SourceControlCreatePullRequestRequest, SourceControlCreatePullRequestResponse, SourceControlPrepareCommitRequest, SourceControlPrepareCommitResponse } from "@matrix-os/contracts";
import type { z } from "zod/v4";
import { AgentThreadSnapshotSchema } from "@matrix-os/contracts";

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
  fetchRuntimeSummary: () => Promise<RuntimeSummary>;
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
}

type Handler<C extends InvokeChannel> = (
  payload: InvokeRequest<C>,
) => Promise<InvokeResponse<C>> | InvokeResponse<C>;

const PUBLIC_IPC_ERRORS = new Set(["invalid request", "internal error", "embed unavailable"]);

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
        result = await handler(parsedRequest.data as InvokeRequest<C>);
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

  handle("runtime:select", async ({ slot }) => {
    await ctx.auth.selectRuntime(slot);
    ctx.onRuntimeChanged(slot);
    return { ok: true };
  });
  handle("runtime:get-summary", () => ctx.fetchRuntimeSummary());
  handle("runtime:get-reviews", (request) => ctx.fetchReviewSummaries(request));
  handle("runtime:get-review-snapshot", (request) => ctx.fetchReviewSnapshot(request));
  handle("runtime:browse-files", (request) => ctx.fetchFileBrowse(request));
  handle("runtime:search-files", (request) => ctx.fetchFileSearch(request));
  handle("runtime:get-file-content", (request) => ctx.fetchFileContent(request));
  handle("runtime:save-file-content", (request) => ctx.saveFileContent(request));
  handle("runtime:prepare-source-commit", (request) => ctx.prepareSourceCommit(request));
  handle("runtime:create-source-pull-request", (request) => ctx.createSourcePullRequest(request));
  handle("runtime:get-thread-snapshot", (request) => ctx.fetchThreadSnapshot(request));
  handle("runtime:submit-approval-decision", (request) => ctx.submitApprovalDecision(request));
  handle("runtime:submit-input-answer", (request) => ctx.submitInputAnswer(request));
  handle("runtime:create-thread", (request) => ctx.createAgentThread(request));

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

  handle("embed:open", async ({ kind, slug, bounds, active }) => {
    try {
      return await ctx.embeds.open({ kind, slug, bounds, active });
    } catch (err: unknown) {
      console.warn(
        "[ipc] embed:open failed:",
        err instanceof Error ? err.message : String(err),
      );
      throw new Error("embed unavailable");
    }
  });
  handle("embed:set-bounds", ({ embedId, bounds }) => ({
    ok: ctx.embeds.setBounds(embedId, bounds),
  }));
  handle("embed:set-active", ({ embedId, active }) => ({
    ok: ctx.embeds.setActive(embedId, active),
  }));
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
}
