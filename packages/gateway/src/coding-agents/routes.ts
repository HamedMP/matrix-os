import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod/v4";
import {
  ApprovalDecisionRequestSchema,
  ApprovalIdSchema,
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
  ProjectIdSchema,
  ProjectAgentWorkspaceSchema,
  RequestIdSchema,
  ThreadIdSchema,
  TaskIdSchema,
  SafeClientErrorSchema,
  UserInputAnswerRequestSchema,
  boundedListSchema,
  AgentThreadSummarySchema,
  ReviewIdSchema,
  ReviewSnapshotSchema,
  ReviewSummarySchema,
  SourceControlCreatePullRequestRequestSchema,
  SourceControlCreatePullRequestResponseSchema,
  SourceControlPrepareCommitRequestSchema,
  SourceControlPrepareCommitResponseSchema,
  CodingAgentNotificationPreferencesSchema,
  CodingAgentNotificationPreferencesUpdateSchema,
} from "@matrix-os/contracts";
import {
  isRequestPrincipalError,
  mapRequestPrincipalError,
  requireRequestPrincipal,
  type RequestPrincipal,
} from "../request-principal.js";
import type { CodingAgentRuntimeSummaryService } from "./runtime-summary.js";
import {
  CodingAgentTurnError,
  CodingAgentThreadError,
  safeThreadError,
  type CodingAgentThreadStore,
  type CodingAgentTurnStore,
} from "./thread-store.js";
import {
  CodingAgentReviewSnapshotError,
  type CodingAgentReviewSummaryStore,
} from "./review-summary.js";
import {
  CodingAgentFileReadError,
  CodingAgentFileWriteError,
  type CodingAgentFileStore,
} from "./file-read.js";
import {
  CodingAgentSourceControlError,
  type CodingAgentSourceControlStore,
} from "./source-control.js";
import type { CodingAgentNotificationPreferenceStore } from "./notification-preferences.js";
import { logCodingAgentWarning } from "./diagnostics.js";
import { CodingAgentProjectWorkspaceError } from "./project-workspace.js";
import { CodingAgentThreadRelationError } from "./thread-relations.js";

export interface CodingAgentRouteDeps {
  service: CodingAgentRuntimeSummaryService;
  projectWorkspaces?: {
    getProjectWorkspace(
      principal: RequestPrincipal,
      projectId: string,
      query: ProjectWorkspaceQuery,
    ): Promise<unknown>;
  };
  threads?: CodingAgentThreadStore;
  turns?: CodingAgentTurnStore;
  reviews?: CodingAgentReviewSummaryStore;
  files?: CodingAgentFileStore;
  sourceControl?: CodingAgentSourceControlStore;
  notificationPreferences?: CodingAgentNotificationPreferenceStore;
  getPrincipal?: (c: Context) => RequestPrincipal;
}

const THREAD_MUTATION_BODY_LIMIT = 128 * 1024;
const THREAD_TURN_BODY_LIMIT = 128 * 1024;
const THREAD_ABORT_BODY_LIMIT = 1024;
const THREAD_APPROVAL_BODY_LIMIT = 8 * 1024;
const THREAD_INPUT_BODY_LIMIT = 40 * 1024;
const FILE_WRITE_BODY_LIMIT = 512 * 1024;
const SOURCE_CONTROL_BODY_LIMIT = 256 * 1024;
const NOTIFICATION_PREFERENCES_BODY_LIMIT = 4 * 1024;

const AbortThreadBodySchema = z.object({
  clientRequestId: RequestIdSchema,
}).strict();

const ThreadListSchema = boundedListSchema(AgentThreadSummarySchema, 50);
const ReviewListSchema = boundedListSchema(ReviewSummarySchema, 50);
const SummaryQuerySchema = z.object({
  projectId: ProjectIdSchema.refine((value) => /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(value), {
    message: "Invalid project id",
  }).optional(),
}).strict();
const ProjectWorkspaceProjectIdSchema = ProjectIdSchema.refine(
  (value) => /^[a-z0-9][a-z0-9-]{0,62}$/.test(value),
  { message: "Invalid project id" },
);
const ProjectWorkspaceQuerySchema = z.object({
  taskCursor: TaskIdSchema.optional(),
  taskLimit: z.coerce.number().int().min(1).max(100).default(50),
  projectThreadCursor: ThreadIdSchema.optional(),
  projectThreadLimit: z.coerce.number().int().min(1).max(100).default(50),
  taskThreadCursor: ThreadIdSchema.optional(),
  taskThreadLimit: z.coerce.number().int().min(1).max(100).default(50),
}).strict();
const SingleProjectWorkspaceQueryValueSchema = z.array(z.string()).length(1).transform((values) => values[0]!);
const ProjectWorkspaceRawQuerySchema = z.object({
  taskCursor: SingleProjectWorkspaceQueryValueSchema.optional(),
  taskLimit: SingleProjectWorkspaceQueryValueSchema.optional(),
  projectThreadCursor: SingleProjectWorkspaceQueryValueSchema.optional(),
  projectThreadLimit: SingleProjectWorkspaceQueryValueSchema.optional(),
  taskThreadCursor: SingleProjectWorkspaceQueryValueSchema.optional(),
  taskThreadLimit: SingleProjectWorkspaceQueryValueSchema.optional(),
}).strict();

type ProjectWorkspaceQuery = z.infer<typeof ProjectWorkspaceQuerySchema>;

function summaryUnavailable() {
  return SafeClientErrorSchema.parse({
    code: "summary_unavailable",
    safeMessage: "Runtime summary is temporarily unavailable. Try again.",
    retryable: true,
    recoveryActions: ["retry"],
  });
}

function threadsUnavailable() {
  return SafeClientErrorSchema.parse({
    code: "thread_store_unavailable",
    safeMessage: "Agent thread state is temporarily unavailable. Try again.",
    retryable: true,
    recoveryActions: ["retry"],
  });
}

function projectWorkspaceUnavailable() {
  return SafeClientErrorSchema.parse({
    code: "project_workspace_unavailable",
    safeMessage: "Project workspace is temporarily unavailable. Refresh and try again.",
    retryable: true,
    recoveryActions: ["retry"],
  });
}

function projectWorkspaceNotFound() {
  return SafeClientErrorSchema.parse({
    code: "project_not_found",
    safeMessage: "Project workspace is unavailable. Refresh and try again.",
    retryable: false,
  });
}

function reviewsUnavailable() {
  return SafeClientErrorSchema.parse({
    code: "review_state_unavailable",
    safeMessage: "Review state is temporarily unavailable. Try again.",
    retryable: true,
    recoveryActions: ["retry"],
  });
}

function filesUnavailable() {
  return SafeClientErrorSchema.parse({
    code: "file_state_unavailable",
    safeMessage: "File content is temporarily unavailable. Try again.",
    retryable: true,
    recoveryActions: ["retry"],
  });
}

function sourceControlUnavailable() {
  return SafeClientErrorSchema.parse({
    code: "source_control_unavailable",
    safeMessage: "Source control is temporarily unavailable. Try again.",
    retryable: true,
    recoveryActions: ["retry"],
  });
}

function sourceControlNotFound() {
  return SafeClientErrorSchema.parse({
    code: "source_control_not_found",
    safeMessage: "Source control is unavailable for this workspace. Refresh and try again.",
    retryable: false,
  });
}

function sourceControlNoChanges() {
  return SafeClientErrorSchema.parse({
    code: "source_control_no_changes",
    safeMessage: "No source changes are ready to commit.",
    retryable: false,
  });
}

function notificationPreferencesUnavailable() {
  return SafeClientErrorSchema.parse({
    code: "notification_preferences_unavailable",
    safeMessage: "Notification preferences are temporarily unavailable. Try again.",
    retryable: true,
    recoveryActions: ["retry"],
  });
}

function reviewNotFound() {
  return SafeClientErrorSchema.parse({
    code: "review_not_found",
    safeMessage: "Review is unavailable. Refresh and try again.",
    retryable: false,
  });
}

function fileNotFound() {
  return SafeClientErrorSchema.parse({
    code: "file_not_found",
    safeMessage: "File is unavailable. Refresh and try again.",
    retryable: false,
  });
}

function fileConflict() {
  return SafeClientErrorSchema.parse({
    code: "file_conflict",
    safeMessage: "File changed before the update could be saved. Refresh and try again.",
    retryable: false,
    recoveryActions: ["retry"],
  });
}

function bodyTooLarge() {
  return SafeClientErrorSchema.parse({
    code: "payload_too_large",
    safeMessage: "Request is too large. Reduce the content and try again.",
    retryable: false,
  });
}

function isBodyLimitError(err: unknown): boolean {
  return err instanceof Error && err.name === "BodyLimitError" && err.message === "Payload Too Large";
}

function validationFailed() {
  return SafeClientErrorSchema.parse({
    code: "validation_failed",
    safeMessage: "Request could not be processed. Check the inputs and try again.",
    retryable: false,
  });
}

function mapThreadRouteError(c: Context, err: unknown) {
  if (isRequestPrincipalError(err)) {
    const mapped = mapRequestPrincipalError(err);
    return c.json(mapped.body, mapped.status as ContentfulStatusCode);
  }
  if (err instanceof CodingAgentThreadError) {
    const status = err.code === "thread_not_found" ? 404 : err.code === "provider_unavailable" ? 400 : 503;
    return c.json({ error: safeThreadError(err.code) }, status);
  }
  if (err instanceof CodingAgentThreadRelationError) {
    if (err.code === "invalid_relation") {
      return c.json({
        error: SafeClientErrorSchema.parse({
          code: "thread_relation_invalid",
          safeMessage: "Choose an available project and task, then try again.",
          retryable: false,
        }),
      }, 400);
    }
    logCodingAgentWarning("thread relation validation unavailable", err);
    return c.json({ error: threadsUnavailable() }, 503);
  }
  if (err instanceof z.ZodError) {
    return c.json({ error: validationFailed() }, 400);
  }
  logCodingAgentWarning("thread route failed", err);
  return c.json({ error: threadsUnavailable() }, 503);
}

function turnError(code: "thread_busy" | "thread_not_found" | "turn_unavailable") {
  if (code === "thread_busy") {
    return CreateAgentTurnErrorSchema.parse({
      code,
      safeMessage: "This conversation is already running. Wait for it to finish and try again.",
      retryable: true,
      recoveryActions: ["retry"],
    });
  }
  if (code === "thread_not_found") {
    return CreateAgentTurnErrorSchema.parse({
      code,
      safeMessage: "Conversation is unavailable. Refresh and try again.",
      retryable: true,
      recoveryActions: ["retry"],
    });
  }
  return CreateAgentTurnErrorSchema.parse({
    code,
    safeMessage: "This conversation cannot accept a message right now. Refresh and try again.",
    retryable: true,
    recoveryActions: ["retry"],
  });
}

export function createCodingAgentRoutes(deps: CodingAgentRouteDeps): Hono {
  const app = new Hono();
  const principalFor = (c: Context) => deps.getPrincipal?.(c) ?? requireRequestPrincipal(c);
  const threadMutationBodyLimit = bodyLimit({ maxSize: THREAD_MUTATION_BODY_LIMIT });
  const threadTurnBodyLimit = bodyLimit({ maxSize: THREAD_TURN_BODY_LIMIT });
  const threadAbortBodyLimit = bodyLimit({ maxSize: THREAD_ABORT_BODY_LIMIT });
  const threadApprovalBodyLimit = bodyLimit({ maxSize: THREAD_APPROVAL_BODY_LIMIT });
  const threadInputBodyLimit = bodyLimit({ maxSize: THREAD_INPUT_BODY_LIMIT });
  const fileWriteBodyLimit = bodyLimit({
    maxSize: FILE_WRITE_BODY_LIMIT,
    onError: (c) => c.json({ error: bodyTooLarge() }, 413),
  });
  const sourceControlBodyLimit = bodyLimit({
    maxSize: SOURCE_CONTROL_BODY_LIMIT,
    onError: (c) => c.json({ error: bodyTooLarge() }, 413),
  });
  const notificationPreferencesBodyLimit = bodyLimit({
    maxSize: NOTIFICATION_PREFERENCES_BODY_LIMIT,
    onError: (c) => c.json({ error: bodyTooLarge() }, 413),
  });

  app.get("/summary", async (c) => {
    try {
      const principal = principalFor(c);
      const query = SummaryQuerySchema.parse({ projectId: c.req.query("projectId") });
      return c.json(await deps.service.getSummary(principal, query));
    } catch (err: unknown) {
      if (isRequestPrincipalError(err)) {
        const mapped = mapRequestPrincipalError(err);
        return c.json(mapped.body, mapped.status as ContentfulStatusCode);
      }
      if (err instanceof z.ZodError) {
        return c.json({ error: validationFailed() }, 400);
      }
      logCodingAgentWarning("summary route failed", err);
      return c.json({ error: summaryUnavailable() }, 503);
    }
  });

  if (deps.projectWorkspaces) {
    app.get("/projects/:projectId/workspace", async (c) => {
      try {
        const principal = principalFor(c);
        const projectId = ProjectWorkspaceProjectIdSchema.parse(c.req.param("projectId"));
        const query = ProjectWorkspaceQuerySchema.parse(
          ProjectWorkspaceRawQuerySchema.parse(c.req.queries()),
        );
        return c.json(ProjectAgentWorkspaceSchema.parse(
          await deps.projectWorkspaces!.getProjectWorkspace(principal, projectId, query),
        ));
      } catch (err: unknown) {
        if (isRequestPrincipalError(err)) {
          const mapped = mapRequestPrincipalError(err);
          return c.json(mapped.body, mapped.status as ContentfulStatusCode);
        }
        if (err instanceof z.ZodError) {
          return c.json({ error: validationFailed() }, 400);
        }
        if (err instanceof CodingAgentProjectWorkspaceError) {
          if (err.code === "project_not_found") {
            return c.json({ error: projectWorkspaceNotFound() }, 404);
          }
          if (err.code === "invalid_cursor") {
            return c.json({ error: validationFailed() }, 400);
          }
          return c.json({ error: projectWorkspaceUnavailable() }, 503);
        }
        logCodingAgentWarning("project workspace route failed", err);
        return c.json({ error: projectWorkspaceUnavailable() }, 503);
      }
    });
  }

  if (deps.turns) {
    app.post("/threads/:threadId/turns", threadTurnBodyLimit, async (c) => {
      try {
        const principal = principalFor(c);
        const threadId = ThreadIdSchema.parse(c.req.param("threadId"));
        const request = CreateAgentTurnRequestSchema.parse(await c.req.json());
        const response = await deps.turns!.acceptTurn(principal, threadId, request);
        return c.json(
          CreateAgentTurnResponseSchema.parse(response),
          response.status === "already_accepted" ? 200 : 202,
        );
      } catch (err: unknown) {
        if (isRequestPrincipalError(err)) {
          const mapped = mapRequestPrincipalError(err);
          return c.json(mapped.body, mapped.status as ContentfulStatusCode);
        }
        if (err instanceof z.ZodError) {
          return c.json({ error: validationFailed() }, 400);
        }
        if (err instanceof CodingAgentTurnError) {
          const status = err.code === "thread_not_found" ? 404 : 409;
          return c.json({ error: turnError(err.code) }, status);
        }
        if (err instanceof CodingAgentThreadRelationError) {
          if (err.code === "invalid_relation") {
            return c.json({ error: turnError("turn_unavailable") }, 409);
          }
          logCodingAgentWarning("turn relation validation unavailable", err);
          return c.json({ error: turnError("turn_unavailable") }, 503);
        }
        logCodingAgentWarning("thread turn route failed", err);
        return c.json({ error: turnError("turn_unavailable") }, 503);
      }
    });
  }

  if (deps.threads) {
    app.post("/threads", threadMutationBodyLimit, async (c) => {
      try {
        const principal = principalFor(c);
        const request = CreateAgentThreadRequestSchema.parse(await c.req.json());
        const result = await deps.threads!.createShellThread(principal, request);
        return c.json(result.snapshot, result.existing ? 200 : 202);
      } catch (err: unknown) {
        return mapThreadRouteError(c, err);
      }
    });

    app.get("/threads", async (c) => {
      try {
        const principal = principalFor(c);
        return c.json(ThreadListSchema.parse(await deps.threads!.listThreads(principal)));
      } catch (err: unknown) {
        return mapThreadRouteError(c, err);
      }
    });

    app.get("/threads/:threadId", async (c) => {
      try {
        const principal = principalFor(c);
        const threadId = ThreadIdSchema.parse(c.req.param("threadId"));
        return c.json(await deps.threads!.getThread(principal, threadId));
      } catch (err: unknown) {
        return mapThreadRouteError(c, err);
      }
    });

    app.get("/threads/:threadId/events", async (c) => {
      try {
        const principal = principalFor(c);
        const threadId = ThreadIdSchema.parse(c.req.param("threadId"));
        const rawCursor = c.req.query("cursor");
        const cursor = rawCursor ? CursorSchema.parse(rawCursor) : undefined;
        return c.json(await deps.threads!.getThread(principal, threadId, cursor));
      } catch (err: unknown) {
        return mapThreadRouteError(c, err);
      }
    });

    app.post("/threads/:threadId/abort", threadAbortBodyLimit, async (c) => {
      try {
        const principal = principalFor(c);
        const threadId = ThreadIdSchema.parse(c.req.param("threadId"));
        const body = AbortThreadBodySchema.parse(await c.req.json());
        return c.json(await deps.threads!.abortThread(principal, threadId, body.clientRequestId));
      } catch (err: unknown) {
        return mapThreadRouteError(c, err);
      }
    });

    app.post("/threads/:threadId/approvals/:approvalId/decision", threadApprovalBodyLimit, async (c) => {
      try {
        const principal = principalFor(c);
        const threadId = ThreadIdSchema.parse(c.req.param("threadId"));
        const approvalId = ApprovalIdSchema.parse(c.req.param("approvalId"));
        const body = ApprovalDecisionRequestSchema.parse(await c.req.json());
        return c.json(await deps.threads!.submitApproval(principal, threadId, approvalId, body));
      } catch (err: unknown) {
        return mapThreadRouteError(c, err);
      }
    });

    app.post("/threads/:threadId/inputs/:inputRequestId/answer", threadInputBodyLimit, async (c) => {
      try {
        const principal = principalFor(c);
        const threadId = ThreadIdSchema.parse(c.req.param("threadId"));
        const inputRequestId = RequestIdSchema.parse(c.req.param("inputRequestId"));
        const body = UserInputAnswerRequestSchema.parse(await c.req.json());
        return c.json(await deps.threads!.submitInput(principal, threadId, inputRequestId, body));
      } catch (err: unknown) {
        return mapThreadRouteError(c, err);
      }
    });
  }

  if (deps.reviews) {
    app.get("/reviews", async (c) => {
      try {
        const principal = principalFor(c);
        const rawCursor = c.req.query("cursor");
        const cursor = rawCursor ? CursorSchema.parse(rawCursor) : undefined;
        return c.json(ReviewListSchema.parse(await deps.reviews!.listReviews(principal, { cursor })));
      } catch (err: unknown) {
        if (isRequestPrincipalError(err)) {
          const mapped = mapRequestPrincipalError(err);
          return c.json(mapped.body, mapped.status as ContentfulStatusCode);
        }
        if (err instanceof z.ZodError) {
          return c.json({ error: validationFailed() }, 400);
        }
        logCodingAgentWarning("review route failed", err);
        return c.json({ error: reviewsUnavailable() }, 503);
      }
    });

    app.get("/reviews/:reviewId", async (c) => {
      try {
        const principal = principalFor(c);
        const reviewId = ReviewIdSchema.parse(c.req.param("reviewId"));
        if (typeof deps.reviews!.getReviewSnapshot !== "function") {
          return c.json({ error: reviewsUnavailable() }, 503);
        }
        return c.json(ReviewSnapshotSchema.parse(await deps.reviews!.getReviewSnapshot(principal, reviewId)));
      } catch (err: unknown) {
        if (isRequestPrincipalError(err)) {
          const mapped = mapRequestPrincipalError(err);
          return c.json(mapped.body, mapped.status as ContentfulStatusCode);
        }
        if (err instanceof z.ZodError) {
          return c.json({ error: validationFailed() }, 400);
        }
        if (err instanceof CodingAgentReviewSnapshotError) {
          const status = err.code === "review_not_found" ? 404 : 503;
          return c.json({ error: err.code === "review_not_found" ? reviewNotFound() : reviewsUnavailable() }, status);
        }
        logCodingAgentWarning("review snapshot route failed", err);
        return c.json({ error: reviewsUnavailable() }, 503);
      }
    });
  }

  if (deps.files) {
    app.get("/files/browse", async (c) => {
      try {
        const principal = principalFor(c);
        const request = FileBrowseRequestSchema.parse({
          projectId: c.req.query("projectId"),
          worktreeId: c.req.query("worktreeId"),
          path: c.req.query("path"),
          limit: c.req.query("limit"),
        });
        return c.json(FileBrowseResponseSchema.parse(await deps.files!.browseFiles(principal, request)));
      } catch (err: unknown) {
        if (isRequestPrincipalError(err)) {
          const mapped = mapRequestPrincipalError(err);
          return c.json(mapped.body, mapped.status as ContentfulStatusCode);
        }
        if (err instanceof z.ZodError) {
          return c.json({ error: validationFailed() }, 400);
        }
        if (err instanceof CodingAgentFileReadError) {
          if (err.code === "file_not_found") return c.json({ error: fileNotFound() }, 404);
          if (err.code === "not_file") return c.json({ error: validationFailed() }, 400);
          return c.json({ error: filesUnavailable() }, 503);
        }
        logCodingAgentWarning("file browse route failed", err);
        return c.json({ error: filesUnavailable() }, 503);
      }
    });

    app.get("/files/read", async (c) => {
      try {
        const principal = principalFor(c);
        const request = FileReadRequestSchema.parse({
          projectId: c.req.query("projectId"),
          worktreeId: c.req.query("worktreeId"),
          path: c.req.query("path"),
        });
        return c.json(FileReadResponseSchema.parse(await deps.files!.readFile(principal, request)));
      } catch (err: unknown) {
        if (isRequestPrincipalError(err)) {
          const mapped = mapRequestPrincipalError(err);
          return c.json(mapped.body, mapped.status as ContentfulStatusCode);
        }
        if (err instanceof z.ZodError) {
          return c.json({ error: validationFailed() }, 400);
        }
        if (err instanceof CodingAgentFileReadError) {
          if (err.code === "file_not_found") return c.json({ error: fileNotFound() }, 404);
          if (err.code === "not_file") return c.json({ error: validationFailed() }, 400);
          return c.json({ error: filesUnavailable() }, 503);
        }
        logCodingAgentWarning("file read route failed", err);
        return c.json({ error: filesUnavailable() }, 503);
      }
    });

    app.get("/files/search", async (c) => {
      try {
        const principal = principalFor(c);
        const request = FileSearchRequestSchema.parse({
          projectId: c.req.query("projectId"),
          worktreeId: c.req.query("worktreeId"),
          path: c.req.query("path"),
          query: c.req.query("query"),
          limit: c.req.query("limit"),
        });
        return c.json(FileSearchResponseSchema.parse(await deps.files!.searchFiles(principal, request)));
      } catch (err: unknown) {
        if (isRequestPrincipalError(err)) {
          const mapped = mapRequestPrincipalError(err);
          return c.json(mapped.body, mapped.status as ContentfulStatusCode);
        }
        if (err instanceof z.ZodError) {
          return c.json({ error: validationFailed() }, 400);
        }
        if (err instanceof CodingAgentFileReadError) {
          if (err.code === "file_not_found") return c.json({ error: fileNotFound() }, 404);
          if (err.code === "not_file") return c.json({ error: validationFailed() }, 400);
          return c.json({ error: filesUnavailable() }, 503);
        }
        logCodingAgentWarning("file search route failed", err);
        return c.json({ error: filesUnavailable() }, 503);
      }
    });

    app.post("/files/write", fileWriteBodyLimit, async (c) => {
      try {
        const principal = principalFor(c);
        const request = FileWriteRequestSchema.parse(await c.req.json());
        const response = FileWriteResponseSchema.parse(await deps.files!.writeFile(principal, request));
        return c.json(response, request.baseEtag === null ? 201 : 200);
      } catch (err: unknown) {
        if (isBodyLimitError(err)) {
          return c.json({ error: bodyTooLarge() }, 413);
        }
        if (isRequestPrincipalError(err)) {
          const mapped = mapRequestPrincipalError(err);
          return c.json(mapped.body, mapped.status as ContentfulStatusCode);
        }
        if (err instanceof z.ZodError || err instanceof SyntaxError) {
          return c.json({ error: validationFailed() }, 400);
        }
        if (err instanceof CodingAgentFileWriteError) {
          if (err.code === "file_not_found") return c.json({ error: fileNotFound() }, 404);
          if (err.code === "file_conflict") return c.json({ error: fileConflict() }, 409);
          if (err.code === "not_file" || err.code === "invalid_request") return c.json({ error: validationFailed() }, 400);
          return c.json({ error: filesUnavailable() }, 503);
        }
        logCodingAgentWarning("file write route failed", err);
        return c.json({ error: filesUnavailable() }, 503);
      }
    });
  }

  if (deps.sourceControl) {
    app.post("/source-control/prepare-commit", sourceControlBodyLimit, async (c) => {
      try {
        const principal = principalFor(c);
        const request = SourceControlPrepareCommitRequestSchema.parse(await c.req.json());
        const response = SourceControlPrepareCommitResponseSchema.parse(
          await deps.sourceControl!.prepareCommit(principal, request),
        );
        return c.json(response, 201);
      } catch (err: unknown) {
        if (isBodyLimitError(err)) {
          return c.json({ error: bodyTooLarge() }, 413);
        }
        if (isRequestPrincipalError(err)) {
          const mapped = mapRequestPrincipalError(err);
          return c.json(mapped.body, mapped.status as ContentfulStatusCode);
        }
        if (err instanceof z.ZodError || err instanceof SyntaxError) {
          return c.json({ error: validationFailed() }, 400);
        }
        if (err instanceof CodingAgentSourceControlError) {
          if (err.code === "source_control_not_found") return c.json({ error: sourceControlNotFound() }, 404);
          if (err.code === "source_control_no_changes") return c.json({ error: sourceControlNoChanges() }, 409);
          if (err.code === "invalid_request") return c.json({ error: validationFailed() }, 400);
          return c.json({ error: sourceControlUnavailable() }, 503);
        }
        logCodingAgentWarning("source-control route failed", err);
        return c.json({ error: sourceControlUnavailable() }, 503);
      }
    });

    app.post("/source-control/pull-requests", sourceControlBodyLimit, async (c) => {
      try {
        const principal = principalFor(c);
        const request = SourceControlCreatePullRequestRequestSchema.parse(await c.req.json());
        const response = SourceControlCreatePullRequestResponseSchema.parse(
          await deps.sourceControl!.createPullRequest(principal, request),
        );
        return c.json(response, response.status === "created" ? 201 : 200);
      } catch (err: unknown) {
        if (isBodyLimitError(err)) {
          return c.json({ error: bodyTooLarge() }, 413);
        }
        if (isRequestPrincipalError(err)) {
          const mapped = mapRequestPrincipalError(err);
          return c.json(mapped.body, mapped.status as ContentfulStatusCode);
        }
        if (err instanceof z.ZodError || err instanceof SyntaxError) {
          return c.json({ error: validationFailed() }, 400);
        }
        if (err instanceof CodingAgentSourceControlError) {
          if (err.code === "source_control_not_found") return c.json({ error: sourceControlNotFound() }, 404);
          if (err.code === "source_control_no_changes") return c.json({ error: sourceControlNoChanges() }, 409);
          if (err.code === "invalid_request") return c.json({ error: validationFailed() }, 400);
          return c.json({ error: sourceControlUnavailable() }, 503);
        }
        logCodingAgentWarning("source-control pull request route failed", err);
        return c.json({ error: sourceControlUnavailable() }, 503);
      }
    });
  }

  if (deps.notificationPreferences) {
    app.get("/notification-preferences", async (c) => {
      try {
        const principal = principalFor(c);
        const preferences = CodingAgentNotificationPreferencesSchema.parse(
          await deps.notificationPreferences!.load(principal),
        );
        return c.json({ preferences });
      } catch (err: unknown) {
        if (isRequestPrincipalError(err)) {
          const mapped = mapRequestPrincipalError(err);
          return c.json(mapped.body, mapped.status as ContentfulStatusCode);
        }
        logCodingAgentWarning("notification preferences route failed", err);
        return c.json({ error: notificationPreferencesUnavailable() }, 503);
      }
    });

    app.put("/notification-preferences", notificationPreferencesBodyLimit, async (c) => {
      try {
        const principal = principalFor(c);
        const request = CodingAgentNotificationPreferencesUpdateSchema.parse(await c.req.json());
        const preferences = CodingAgentNotificationPreferencesSchema.parse(
          await deps.notificationPreferences!.save(principal, request),
        );
        return c.json({ preferences });
      } catch (err: unknown) {
        if (isBodyLimitError(err)) {
          return c.json({ error: bodyTooLarge() }, 413);
        }
        if (isRequestPrincipalError(err)) {
          const mapped = mapRequestPrincipalError(err);
          return c.json(mapped.body, mapped.status as ContentfulStatusCode);
        }
        if (err instanceof z.ZodError || err instanceof SyntaxError) {
          return c.json({ error: validationFailed() }, 400);
        }
        logCodingAgentWarning("notification preferences update failed", err);
        return c.json({ error: notificationPreferencesUnavailable() }, 503);
      }
    });
  }

  return app;
}
