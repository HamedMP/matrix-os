import {
  AgentThreadSnapshotSchema,
  ReviewSnapshotSchema,
  ReviewSummarySchema,
  RuntimeSummarySchema,
  type CreateAgentThreadRequest,
  type ReviewSnapshot,
  type ReviewSummary,
  type RuntimeSummary,
  boundedListSchema,
} from "@matrix-os/contracts";
import type { z } from "zod/v4";
import type { AuthService } from "../auth/auth-service";

const RUNTIME_SUMMARY_TIMEOUT_MS = 10_000;
const REVIEW_SUMMARY_TIMEOUT_MS = 10_000;
const REVIEW_SNAPSHOT_TIMEOUT_MS = 10_000;
const THREAD_CREATE_TIMEOUT_MS = 15_000;

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;
type AgentThreadSnapshot = z.infer<typeof AgentThreadSnapshotSchema>;
const ReviewSummaryListSchema = boundedListSchema(ReviewSummarySchema, 50);
type ReviewSummaryList = z.infer<typeof ReviewSummaryListSchema>;

function buildSummaryUrl(origin: string, runtimeSlot: string): string {
  const url = new URL("/api/coding-agents/summary", origin);
  if (runtimeSlot !== "primary") {
    url.searchParams.set("runtime", runtimeSlot);
  }
  return url.toString();
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

export async function createCodingAgentThread(
  auth: AuthService,
  request: CreateAgentThreadRequest,
  fetchFn: FetchFn = fetch,
): Promise<AgentThreadSnapshot> {
  const token = auth.getToken();
  if (!token) {
    throw new Error("agent thread unavailable");
  }

  const url = new URL("/api/coding-agents/threads", auth.getGatewayOrigin()).toString();
  const res = await fetchFn(url, {
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

export async function fetchCodingAgentReviewSummaries(
  auth: AuthService,
  options: { cursor?: string } = {},
  fetchFn: FetchFn = fetch,
): Promise<ReviewSummaryList> {
  const token = auth.getToken();
  if (!token) {
    throw new Error("review state unavailable");
  }

  const url = new URL("/api/coding-agents/reviews", auth.getGatewayOrigin());
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

  const url = new URL(
    `/api/coding-agents/reviews/${encodeURIComponent(options.reviewId)}`,
    auth.getGatewayOrigin(),
  );
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
