import {
  AgentThreadSnapshotSchema,
  CodingAgentNotificationPreferencesSchema,
  CodingAgentNotificationPreferencesUpdateSchema,
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
  type ApprovalDecisionRequest,
  type CodingAgentNotificationPreferences,
  type CodingAgentNotificationPreferencesUpdate,
  type CreateAgentThreadRequest,
  type FileBrowseRequest,
  type FileBrowseResponse,
  type FileReadRequest,
  type FileReadResponse,
  type FileSearchRequest,
  type FileSearchResponse,
  type FileWriteRequest,
  type FileWriteResponse,
  type ReviewSnapshot,
  type ReviewSummary,
  type RuntimeSummary,
  type SourceControlCreatePullRequestRequest,
  type SourceControlCreatePullRequestResponse,
  type SourceControlPrepareCommitRequest,
  type SourceControlPrepareCommitResponse,
  type UserInputAnswerRequest,
  boundedListSchema,
} from "@matrix-os/contracts";
import { z } from "zod/v4";
import type { AuthService } from "../auth/auth-service";

const RUNTIME_SUMMARY_TIMEOUT_MS = 10_000;
const NOTIFICATION_PREFERENCES_TIMEOUT_MS = 10_000;
const REVIEW_SUMMARY_TIMEOUT_MS = 10_000;
const REVIEW_SNAPSHOT_TIMEOUT_MS = 10_000;
const FILE_BROWSE_TIMEOUT_MS = 10_000;
const FILE_SEARCH_TIMEOUT_MS = 10_000;
const FILE_READ_TIMEOUT_MS = 10_000;
const FILE_WRITE_TIMEOUT_MS = 10_000;
const SOURCE_CONTROL_TIMEOUT_MS = 10_000;
const THREAD_CREATE_TIMEOUT_MS = 15_000;
const THREAD_SNAPSHOT_TIMEOUT_MS = 10_000;
const APPROVAL_DECISION_TIMEOUT_MS = 10_000;
const INPUT_ANSWER_TIMEOUT_MS = 10_000;

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;
type AgentThreadSnapshot = z.infer<typeof AgentThreadSnapshotSchema>;
const ReviewSummaryListSchema = boundedListSchema(ReviewSummarySchema, 50);
type ReviewSummaryList = z.infer<typeof ReviewSummaryListSchema>;
const NotificationPreferencesResponseSchema = z.object({
  preferences: CodingAgentNotificationPreferencesSchema,
}).strict();

function buildSummaryUrl(origin: string, runtimeSlot: string): string {
  const url = new URL("/api/coding-agents/summary", origin);
  if (runtimeSlot !== "primary") {
    url.searchParams.set("runtime", runtimeSlot);
  }
  return url.toString();
}

function buildRuntimeUrl(auth: AuthService, path: string): URL {
  const url = new URL(path, auth.getGatewayOrigin());
  const runtimeSlot = auth.getStatus().runtimeSlot;
  if (runtimeSlot !== "primary") {
    url.searchParams.set("runtime", runtimeSlot);
  }
  return url;
}

export async function fetchCodingAgentRuntimeSummary(
  auth: AuthService,
  fetchFn: FetchFn = fetch,
): Promise<RuntimeSummary> {
  const token = auth.getToken();
  if (!token) {
    throw new Error("runtime summary unavailable");
  }

  const status = auth.getStatus();
  const url = buildSummaryUrl(auth.getGatewayOrigin(), status.runtimeSlot);
  const res = await fetchFn(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(RUNTIME_SUMMARY_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error("runtime summary unavailable");
  }

  const body = await res.json();
  const parsed = RuntimeSummarySchema.safeParse(body);
  if (!parsed.success) {
    throw new Error("runtime summary unavailable");
  }
  return parsed.data;
}

export async function fetchCodingAgentNotificationPreferences(
  auth: AuthService,
  fetchFn: FetchFn = fetch,
): Promise<CodingAgentNotificationPreferences> {
  const token = auth.getToken();
  if (!token) {
    throw new Error("notification settings unavailable");
  }

  const url = buildRuntimeUrl(auth, "/api/coding-agents/notification-preferences");
  const res = await fetchFn(url.toString(), {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(NOTIFICATION_PREFERENCES_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error("notification settings unavailable");
  }

  const body = await res.json();
  const parsed = NotificationPreferencesResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error("notification settings unavailable");
  }
  return parsed.data.preferences;
}

export async function updateCodingAgentNotificationPreferences(
  auth: AuthService,
  request: CodingAgentNotificationPreferencesUpdate,
  fetchFn: FetchFn = fetch,
): Promise<CodingAgentNotificationPreferences> {
  const token = auth.getToken();
  if (!token) {
    throw new Error("notification settings unavailable");
  }

  const parsedRequest = CodingAgentNotificationPreferencesUpdateSchema.safeParse(request);
  if (!parsedRequest.success) {
    throw new Error("notification settings unavailable");
  }

  const url = buildRuntimeUrl(auth, "/api/coding-agents/notification-preferences");
  const res = await fetchFn(url.toString(), {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(parsedRequest.data),
    signal: AbortSignal.timeout(NOTIFICATION_PREFERENCES_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error("notification settings unavailable");
  }

  const body = await res.json();
  const parsed = NotificationPreferencesResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error("notification settings unavailable");
  }
  return parsed.data.preferences;
}

export async function createCodingAgentThread(
  auth: AuthService,
  request: CreateAgentThreadRequest,
  fetchFn: FetchFn = fetch,
): Promise<AgentThreadSnapshot> {
  const token = auth.getToken();
  if (!token) {
    throw new Error("agent thread unavailable");
  }

  const url = buildRuntimeUrl(auth, "/api/coding-agents/threads");
  const res = await fetchFn(url.toString(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(THREAD_CREATE_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error("agent thread unavailable");
  }

  const body = await res.json();
  const parsed = AgentThreadSnapshotSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error("agent thread unavailable");
  }
  return parsed.data;
}

export async function fetchCodingAgentThreadSnapshot(
  auth: AuthService,
  options: { threadId: string },
  fetchFn: FetchFn = fetch,
): Promise<AgentThreadSnapshot> {
  const token = auth.getToken();
  if (!token) {
    throw new Error("thread state unavailable");
  }

  const url = buildRuntimeUrl(auth, `/api/coding-agents/threads/${encodeURIComponent(options.threadId)}`);
  const res = await fetchFn(url.toString(), {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(THREAD_SNAPSHOT_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error("thread state unavailable");
  }

  const body = await res.json();
  const parsed = AgentThreadSnapshotSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error("thread state unavailable");
  }
  return parsed.data;
}

export async function submitCodingAgentApprovalDecision(
  auth: AuthService,
  options: { threadId: string; approvalId: string; request: ApprovalDecisionRequest },
  fetchFn: FetchFn = fetch,
): Promise<AgentThreadSnapshot> {
  const token = auth.getToken();
  if (!token) {
    throw new Error("approval unavailable");
  }

  const url = buildRuntimeUrl(
    auth,
    `/api/coding-agents/threads/${encodeURIComponent(options.threadId)}/approvals/${encodeURIComponent(options.approvalId)}/decision`,
  );
  const res = await fetchFn(url.toString(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(options.request),
    signal: AbortSignal.timeout(APPROVAL_DECISION_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error("approval unavailable");
  }

  const body = await res.json();
  const parsed = AgentThreadSnapshotSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error("approval unavailable");
  }
  return parsed.data;
}

export async function submitCodingAgentInputAnswer(
  auth: AuthService,
  options: { threadId: string; inputRequestId: string; request: UserInputAnswerRequest },
  fetchFn: FetchFn = fetch,
): Promise<AgentThreadSnapshot> {
  const token = auth.getToken();
  if (!token) {
    throw new Error("input unavailable");
  }

  const url = buildRuntimeUrl(
    auth,
    `/api/coding-agents/threads/${encodeURIComponent(options.threadId)}/inputs/${encodeURIComponent(options.inputRequestId)}/answer`,
  );
  const res = await fetchFn(url.toString(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(options.request),
    signal: AbortSignal.timeout(INPUT_ANSWER_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error("input unavailable");
  }

  const body = await res.json();
  const parsed = AgentThreadSnapshotSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error("input unavailable");
  }
  return parsed.data;
}

export async function fetchCodingAgentReviewSummaries(
  auth: AuthService,
  options: { cursor?: string } = {},
  fetchFn: FetchFn = fetch,
): Promise<ReviewSummaryList> {
  const token = auth.getToken();
  if (!token) {
    throw new Error("review state unavailable");
  }

  const url = buildRuntimeUrl(auth, "/api/coding-agents/reviews");
  if (options.cursor) {
    url.searchParams.set("cursor", options.cursor);
  }
  const res = await fetchFn(url.toString(), {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(REVIEW_SUMMARY_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error("review state unavailable");
  }

  const body = await res.json();
  const parsed = ReviewSummaryListSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error("review state unavailable");
  }
  return parsed.data;
}

export async function fetchCodingAgentReviewSnapshot(
  auth: AuthService,
  options: { reviewId: string },
  fetchFn: FetchFn = fetch,
): Promise<ReviewSnapshot> {
  const token = auth.getToken();
  if (!token) {
    throw new Error("review state unavailable");
  }

  const url = buildRuntimeUrl(auth, `/api/coding-agents/reviews/${encodeURIComponent(options.reviewId)}`);
  const res = await fetchFn(url.toString(), {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(REVIEW_SNAPSHOT_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error("review state unavailable");
  }

  const body = await res.json();
  const parsed = ReviewSnapshotSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error("review state unavailable");
  }
  return parsed.data;
}

export async function fetchCodingAgentFileBrowse(
  auth: AuthService,
  request: FileBrowseRequest,
  fetchFn: FetchFn = fetch,
): Promise<FileBrowseResponse> {
  const token = auth.getToken();
  if (!token) {
    throw new Error("file list unavailable");
  }

  const parsedRequest = FileBrowseRequestSchema.safeParse(request);
  if (!parsedRequest.success) {
    throw new Error("file list unavailable");
  }

  const url = buildRuntimeUrl(auth, "/api/coding-agents/files/browse");
  url.searchParams.set("projectId", parsedRequest.data.projectId);
  if (parsedRequest.data.worktreeId) {
    url.searchParams.set("worktreeId", parsedRequest.data.worktreeId);
  }
  if (parsedRequest.data.path) {
    url.searchParams.set("path", parsedRequest.data.path);
  }
  url.searchParams.set("limit", String(parsedRequest.data.limit));
  const res = await fetchFn(url.toString(), {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(FILE_BROWSE_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error("file list unavailable");
  }

  const body = await res.json();
  const parsed = FileBrowseResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error("file list unavailable");
  }
  return parsed.data;
}

export async function fetchCodingAgentFileSearch(
  auth: AuthService,
  request: FileSearchRequest,
  fetchFn: FetchFn = fetch,
): Promise<FileSearchResponse> {
  const token = auth.getToken();
  if (!token) {
    throw new Error("file search unavailable");
  }

  const parsedRequest = FileSearchRequestSchema.safeParse(request);
  if (!parsedRequest.success) {
    throw new Error("file search unavailable");
  }

  const url = buildRuntimeUrl(auth, "/api/coding-agents/files/search");
  url.searchParams.set("projectId", parsedRequest.data.projectId);
  if (parsedRequest.data.worktreeId) {
    url.searchParams.set("worktreeId", parsedRequest.data.worktreeId);
  }
  if (parsedRequest.data.path) {
    url.searchParams.set("path", parsedRequest.data.path);
  }
  url.searchParams.set("query", parsedRequest.data.query);
  url.searchParams.set("limit", String(parsedRequest.data.limit));
  const res = await fetchFn(url.toString(), {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(FILE_SEARCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error("file search unavailable");
  }

  const body = await res.json();
  const parsed = FileSearchResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error("file search unavailable");
  }
  return parsed.data;
}

export async function fetchCodingAgentFileContent(
  auth: AuthService,
  request: FileReadRequest,
  fetchFn: FetchFn = fetch,
): Promise<FileReadResponse> {
  const token = auth.getToken();
  if (!token) {
    throw new Error("file content unavailable");
  }

  const parsedRequest = FileReadRequestSchema.safeParse(request);
  if (!parsedRequest.success) {
    throw new Error("file content unavailable");
  }

  const url = buildRuntimeUrl(auth, "/api/coding-agents/files/read");
  url.searchParams.set("projectId", parsedRequest.data.projectId);
  if (parsedRequest.data.worktreeId) {
    url.searchParams.set("worktreeId", parsedRequest.data.worktreeId);
  }
  url.searchParams.set("path", parsedRequest.data.path);
  const res = await fetchFn(url.toString(), {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(FILE_READ_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error("file content unavailable");
  }

  const body = await res.json();
  const parsed = FileReadResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error("file content unavailable");
  }
  return parsed.data;
}

export async function saveCodingAgentFileContent(
  auth: AuthService,
  request: FileWriteRequest,
  fetchFn: FetchFn = fetch,
): Promise<FileWriteResponse> {
  const token = auth.getToken();
  if (!token) {
    throw new Error("file save unavailable");
  }

  const parsedRequest = FileWriteRequestSchema.safeParse(request);
  if (!parsedRequest.success) {
    throw new Error("file save unavailable");
  }

  const url = buildRuntimeUrl(auth, "/api/coding-agents/files/write");
  const res = await fetchFn(url.toString(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(parsedRequest.data),
    signal: AbortSignal.timeout(FILE_WRITE_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error("file save unavailable");
  }

  const body = await res.json();
  const parsed = FileWriteResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error("file save unavailable");
  }
  return parsed.data;
}

export async function prepareCodingAgentSourceCommit(
  auth: AuthService,
  request: SourceControlPrepareCommitRequest,
  fetchFn: FetchFn = fetch,
): Promise<SourceControlPrepareCommitResponse> {
  const token = auth.getToken();
  if (!token) {
    throw new Error("source commit unavailable");
  }

  const parsedRequest = SourceControlPrepareCommitRequestSchema.safeParse(request);
  if (!parsedRequest.success) {
    throw new Error("source commit unavailable");
  }

  const url = buildRuntimeUrl(auth, "/api/coding-agents/source-control/prepare-commit");
  const res = await fetchFn(url.toString(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(parsedRequest.data),
    signal: AbortSignal.timeout(SOURCE_CONTROL_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error("source commit unavailable");
  }

  const body = await res.json();
  const parsed = SourceControlPrepareCommitResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error("source commit unavailable");
  }
  return parsed.data;
}

export async function createCodingAgentSourcePullRequest(
  auth: AuthService,
  request: SourceControlCreatePullRequestRequest,
  fetchFn: FetchFn = fetch,
): Promise<SourceControlCreatePullRequestResponse> {
  const token = auth.getToken();
  if (!token) {
    throw new Error("pull request unavailable");
  }

  const parsedRequest = SourceControlCreatePullRequestRequestSchema.safeParse(request);
  if (!parsedRequest.success) {
    throw new Error("pull request unavailable");
  }

  const url = buildRuntimeUrl(auth, "/api/coding-agents/source-control/pull-requests");
  const res = await fetchFn(url.toString(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(parsedRequest.data),
    signal: AbortSignal.timeout(SOURCE_CONTROL_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error("pull request unavailable");
  }

  const body = await res.json();
  const parsed = SourceControlCreatePullRequestResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error("pull request unavailable");
  }
  return parsed.data;
}
