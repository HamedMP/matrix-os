/**
 * Deterministic in-process backend for the standalone Aoede fixture.
 *
 * It fakes exactly the seams `ShellAoedeHost` documents — the gateway `fetcher`
 * plus the media `voiceFactory` — and nothing else. Every response is re-parsed
 * through the authoritative contract schema before it is served, so payload
 * drift fails loudly in the console/evidence instead of silently presenting a
 * broken panel. No network, no providers, no credentials.
 */
import {
  AoedeBootstrapRequestSchema,
  AoedeBootstrapResponseSchema,
  CanonicalCancelChatRunRequestSchema,
  CanonicalChatActionCancellationResponseSchema,
  CanonicalChatApprovalSubmissionResponseSchema,
  CanonicalChatDetailResponseSchema,
  CanonicalChatInputSubmissionResponseSchema,
  CanonicalChatRecordSchema,
  CanonicalProviderCatalogSchema,
  CanonicalSubmitChatApprovalRequestSchema,
  CanonicalSubmitChatInputRequestSchema,
  CanonicalUpdateChatSelectionRequestSchema,
  type AoedeBootstrapResponse,
  type CanonicalChatDetailResponse,
} from "@matrix-os/contracts";
import { fixtureBootstrap, fixtureProviderCatalog, FIXTURE_CHAT_ID } from "./payloads";

export interface FixtureCallRecord {
  index: number;
  method: string;
  path: string;
  status: number;
  note?: string;
}

export interface FixtureEvidenceSnapshot {
  calls: FixtureCallRecord[];
  media: string[];
  navigation: string[];
  schemaIssues: string[];
}

export interface FixtureEvidence {
  subscribe(listener: () => void): () => void;
  snapshot(): FixtureEvidenceSnapshot;
  recordCall(record: Omit<FixtureCallRecord, "index">): void;
  recordMedia(entry: string): void;
  recordNavigation(entry: string): void;
  recordSchemaIssue(issue: string): void;
}

export function createFixtureEvidence(): FixtureEvidence {
  const calls: FixtureCallRecord[] = [];
  const media: string[] = [];
  const navigation: string[] = [];
  const schemaIssues: string[] = [];
  const listeners = new Set<() => void>();
  // useSyncExternalStore compares getSnapshot results — cache until a record lands.
  let cached: FixtureEvidenceSnapshot = { calls, media, navigation, schemaIssues };
  const refresh = () => {
    cached = {
      calls: [...calls],
      media: [...media],
      navigation: [...navigation],
      schemaIssues: [...schemaIssues],
    };
  };
  const notify = () => {
    refresh();
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // evidence listeners must never break the fixture
      }
    }
  };
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    snapshot: () => cached,
    recordCall(record) {
      calls.push({ ...record, index: calls.length + 1 });
      notify();
    },
    recordMedia(entry) {
      media.push(entry);
      notify();
    },
    recordNavigation(entry) {
      navigation.push(entry);
      notify();
    },
    recordSchemaIssue(issue) {
      schemaIssues.push(issue);
      notify();
    },
  };
}

/**
 * Build the canonical fetcher for one scenario. `detail` is held mutably so
 * POST mutations move the projection the same way the real authority does.
 */
export function createFixtureBackend(options: {
  detail: CanonicalChatDetailResponse;
  bootstrap?: Partial<AoedeBootstrapResponse>;
  evidence: FixtureEvidence;
  /** Test-only override: force the action-cancel outcome (e.g. "unknown"). */
  forceActionCancellation?: "unknown";
}): { fetcher: typeof fetch; detail(): CanonicalChatDetailResponse } {
  const { evidence } = options;
  let detail = options.detail;
  let sequence = 100;

  // Eager validation: broken canned payloads fail at fixture construction,
  // not three interactions deep inside the panel.
  const issues: string[] = [];
  for (const [name, parsed] of [
    ["bootstrap", AoedeBootstrapResponseSchema.safeParse(fixtureBootstrap(options.bootstrap))],
    ["detail", CanonicalChatDetailResponseSchema.safeParse(detail)],
    ["providers", CanonicalProviderCatalogSchema.safeParse(fixtureProviderCatalog())],
  ] as const) {
    if (!parsed.success) issues.push(`${name}: ${parsed.error.issues.map(i => i.message).join("; ")}`);
  }
  for (const issue of issues) evidence.recordSchemaIssue(issue);

  const catalog = fixtureProviderCatalog();
  const nextSeq = () => ++sequence;
  const stamp = () => new Date().toISOString();

  const mutateDetail = (work: (draft: CanonicalChatDetailResponse) => void) => {
    const draft = structuredClone(detail);
    work(draft);
    draft.record.chat.revision += 1;
    draft.record.chat.updatedAt = stamp();
    const parsed = CanonicalChatDetailResponseSchema.safeParse(draft);
    if (!parsed.success) {
      evidence.recordSchemaIssue(`mutated detail: ${parsed.error.issues.map(i => `${i.path.join(".")} ${i.message}`).join("; ")}`);
      return;
    }
    detail = parsed.data;
  };

  const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });

  const eventsResponse = (method: string, path: string) => {
    evidence.recordCall({ method, path, status: 200, note: "sse attach" });
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // One attached frame is enough to mark the source open; the stream
        // then stays open (real pushes stay silent — mutations refresh via
        // the detail read path, which is what the fixtures assert).
        controller.enqueue(encoder.encode("id: 1\ndata: {\"type\":\"chat.stream.attached\"}\n\n"));
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };

  const notFound = (method: string, path: string, note = "unhandled route") => {
    evidence.recordCall({ method, path, status: 404, note });
    return json({ error: { code: "not_found", message: "Fixture route not found" } }, 404);
  };

  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const path = url.pathname;
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? safeJson(init.body) : null;

    if (method === "GET" && path === "/api/chats/events") return eventsResponse(method, path + url.search);

    if (method === "POST" && path === "/api/aoede/bootstrap") {
      const parsed = AoedeBootstrapRequestSchema.safeParse(body);
      if (!parsed.success) {
        evidence.recordCall({ method, path, status: 422, note: "bootstrap request invalid" });
        evidence.recordSchemaIssue(`bootstrap request: ${parsed.error.issues.map(i => i.message).join("; ")}`);
        return json({ error: { code: "invalid_request", message: "Invalid bootstrap request" } }, 422);
      }
      const bootstrap = fixtureBootstrap({
        ...options.bootstrap,
        capability: {
          ...fixtureBootstrap().capability,
          ...options.bootstrap?.capability,
          // The capability always echoes the requested surface — a bootstrap on
          // web_desktop must report web_desktop, not the scenario default.
          surface: parsed.data.surface,
        },
      });
      evidence.recordCall({ method, path, status: 200, note: `intent=${parsed.data.intent} surface=${parsed.data.surface}` });
      return json(bootstrap);
    }

    if (method === "GET" && path === "/api/chat-providers") {
      evidence.recordCall({ method, path, status: 200 });
      return json(CanonicalProviderCatalogSchema.parse(catalog));
    }

    const chatMatch = path.match(/^\/api\/chats\/([^/]+)$/);
    if (chatMatch && method === "GET") {
      if (decodeURIComponent(chatMatch[1]) !== FIXTURE_CHAT_ID) return notFound(method, path, "unknown chat id");
      evidence.recordCall({ method, path, status: 200 });
      return json(detail);
    }

    const selectionMatch = path.match(/^\/api\/chats\/([^/]+)\/selection$/);
    if (selectionMatch && method === "PATCH") {
      const parsed = CanonicalUpdateChatSelectionRequestSchema.safeParse(body);
      if (!parsed.success) return notFound(method, path, "selection request invalid");
      mutateDetail((draft) => {
        draft.record.chat.currentSelection = parsed.data.selection;
      });
      evidence.recordCall({ method, path, status: 200, note: `selection -> ${parsed.data.selection.model}` });
      return json(CanonicalChatRecordSchema.parse(detail.record));
    }

    const cancelMatch = path.match(/^\/api\/chats\/([^/]+)\/runs\/([^/]+)\/cancel$/);
    if (cancelMatch && method === "POST") {
      const parsed = CanonicalCancelChatRunRequestSchema.safeParse(body);
      const runId = decodeURIComponent(cancelMatch[2]);
      if (!parsed.success) return notFound(method, path, "cancel request invalid");
      const run = detail.runs.find(item => item.id === runId);
      if (!run) return notFound(method, path, "run not found");
      const terminal = ["completed", "failed", "aborted"].includes(run.status);
      mutateDetail((draft) => {
        const target = draft.runs.find(item => item.id === runId);
        if (!target) return;
        if (!terminal) {
          target.status = "aborted";
          target.outcome = "aborted";
          target.completedAt = stamp();
          draft.turns = draft.turns.map(turn =>
            turn.id === target.turnId ? { ...turn, status: "aborted", updatedAt: stamp() } : turn);
          if (draft.record.activeRun?.runId === runId) delete draft.record.activeRun;
          draft.record.chat.attention = "none";
        }
      });
      evidence.recordCall({ method, path, status: 200, note: terminal ? "already terminal" : "run aborted" });
      const updated = detail.runs.find(item => item.id === runId)!;
      return json({ run: updated, cancellation: terminal ? "already_terminal" : "aborted", ...(terminal ? {} : { granularity: "run" }) });
    }

    const approvalMatch = path.match(/^\/api\/chats\/([^/]+)\/runs\/([^/]+)\/approvals\/([^/]+)$/);
    if (approvalMatch && method === "POST") {
      const parsed = CanonicalSubmitChatApprovalRequestSchema.safeParse(body);
      const approvalId = decodeURIComponent(approvalMatch[3]);
      const runId = decodeURIComponent(approvalMatch[2]);
      if (!parsed.success) return notFound(method, path, "approval request invalid");
      const requested = detail.activities.find(
        item => item.type === "approval.requested" && item.approvalId === approvalId && item.runId === runId,
      );
      if (!requested || requested.type !== "approval.requested") return notFound(method, path, "approval not found");
      if (requested.argumentDigest && parsed.data.argumentDigest && requested.argumentDigest !== parsed.data.argumentDigest) {
        return notFound(method, path, "digest mismatch");
      }
      mutateDetail((draft) => {
        draft.activities.push({
          id: `activity_approval_resolved_${nextSeq()}`,
          chatId: FIXTURE_CHAT_ID,
          runId,
          occurredAt: stamp(),
          type: "approval.resolved",
          approvalId,
          decision: parsed.data.decision,
          ...(parsed.data.argumentDigest ? { argumentDigest: parsed.data.argumentDigest } : {}),
        });
        const run = draft.runs.find(item => item.id === runId);
        if (run && run.status === "waiting_for_approval") {
          run.status = "running";
          run.updatedAt = stamp();
          if (draft.record.activeRun?.runId === runId) draft.record.activeRun = { ...draft.record.activeRun, status: "running" };
        }
        draft.record.chat.attention = "none";
      });
      evidence.recordCall({ method, path, status: 200, note: `decision=${parsed.data.decision}` });
      const response = { approvalId, decision: parsed.data.decision, submission: "accepted" };
      return json(CanonicalChatApprovalSubmissionResponseSchema.parse(response));
    }

    const inputMatch = path.match(/^\/api\/chats\/([^/]+)\/runs\/([^/]+)\/inputs\/([^/]+)$/);
    if (inputMatch && method === "POST") {
      const parsed = CanonicalSubmitChatInputRequestSchema.safeParse(body);
      const requestId = decodeURIComponent(inputMatch[3]);
      const runId = decodeURIComponent(inputMatch[2]);
      if (!parsed.success) return notFound(method, path, "input request invalid");
      const exists = detail.activities.some(
        item => item.type === "input.requested" && item.requestId === requestId && item.runId === runId,
      );
      if (!exists) return notFound(method, path, "input request not found");
      mutateDetail((draft) => {
        const now = stamp();
        draft.activities.push({
          id: `activity_input_submitted_${nextSeq()}`,
          chatId: FIXTURE_CHAT_ID,
          runId,
          occurredAt: now,
          type: "input.submitted",
          requestId,
          clientRequestId: parsed.data.clientRequestId,
        });
        draft.activities.push({
          id: `activity_input_resolved_${nextSeq()}`,
          chatId: FIXTURE_CHAT_ID,
          runId,
          occurredAt: now,
          type: "input.resolved",
          requestId,
          reason: "answered",
        });
        const run = draft.runs.find(item => item.id === runId);
        if (run && run.status === "waiting_for_input") {
          run.status = "running";
          run.updatedAt = now;
          if (draft.record.activeRun?.runId === runId) draft.record.activeRun = { ...draft.record.activeRun, status: "running" };
        }
        draft.record.chat.attention = "none";
      });
      evidence.recordCall({ method, path, status: 200, note: "input submitted" });
      return json(CanonicalChatInputSubmissionResponseSchema.parse({ requestId, submission: "accepted" }));
    }

    const actionMatch = path.match(/^\/api\/chats\/([^/]+)\/actions\/([^/]+)\/cancel$/);
    if (actionMatch && method === "POST") {
      const actionId = decodeURIComponent(actionMatch[2]);
      const operation = detail.operations?.find(item => item.id === actionId);
      if (!operation) return notFound(method, path, "operation not found");
      if (options.forceActionCancellation) {
        evidence.recordCall({ method, path, status: 200, note: `action ${options.forceActionCancellation}` });
        return json(CanonicalChatActionCancellationResponseSchema.parse({
          operation, cancellation: options.forceActionCancellation,
        }));
      }
      const pre = ["proposed", "waiting_for_approval", "authorized"].includes(operation.state);
      const inFlight = ["running", "outcome_unknown"].includes(operation.state) && !operation.cancellationRequested;
      if (!pre && !inFlight) {
        evidence.recordCall({ method, path, status: 200, note: "operation already terminal" });
        return json(CanonicalChatActionCancellationResponseSchema.parse({ operation, cancellation: "already_terminal" }));
      }
      const cancellation = inFlight ? "requested" : "cancelled";
      mutateDetail((draft) => {
        const target = draft.operations?.find(item => item.id === actionId);
        if (!target) return;
        target.cancellationRequested = true;
        target.updatedAt = stamp();
        if (cancellation === "cancelled") target.state = "cancelled";
      });
      evidence.recordCall({ method, path, status: 200, note: `action ${cancellation}` });
      const updated = detail.operations!.find(item => item.id === actionId)!;
      return json(CanonicalChatActionCancellationResponseSchema.parse({ operation: updated, cancellation }));
    }

    return notFound(method, path, "unhandled route");
  };

  return { fetcher, detail: () => detail };
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
