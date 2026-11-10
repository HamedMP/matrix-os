import { useEffect, useRef, useState } from "react";
import { z } from "zod/v4";
import { AppError } from "../../../../shared/app-error";
import { Button } from "../../design/primitives";
import type { ApiClient } from "../../lib/api";
import { useTabs } from "../../stores/tabs";
import { useUi } from "../../stores/ui";

const PATH = "/api/hosted-bots/integrations";
const LEGACY_PATH = "/api/hosted-bots/drive";
const POLL_INTERVAL = 2_000;
const RETRY_INTERVAL = 10_000;
const REQUEST_OPTIONS = { omitErrorBody: true, maxBytes: 32 * 1024 };

const Slug = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u);
const FileId = z.string().regex(/^[A-Za-z0-9_-]{1,256}$/u);
const Request = z.strictObject({
  id: z.uuid(),
  expiresAt: z.number().int().positive(),
  status: z.enum(["pending", "reading"]),
});
const IntegrationRequest = Request.extend({
  service: Slug,
  action: Slug,
  params: z.record(z.string(), z.json()),
});
const Account = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u),
  label: z.string().min(1).max(100),
});
const IntegrationAccount = Account.extend({ service: Slug });
const Snapshot = z.strictObject({
  requests: z.array(IntegrationRequest).max(4),
  accounts: z.array(IntegrationAccount).max(16),
});
const LegacySnapshot = z.strictObject({
  requests: z.array(Request.extend({ fileId: FileId })).max(4),
  accounts: z.array(Account).max(16),
}).transform(({ requests, accounts }): z.infer<typeof Snapshot> => ({
  requests: requests.map(({ fileId, ...request }) => ({
    ...request, service: "google_drive", action: "read_file", params: { fileId },
  })),
  accounts: accounts.map((account) => ({ ...account, service: "google_drive" })),
}));

type IntegrationRequest = z.infer<typeof IntegrationRequest>;
type IntegrationAccount = z.infer<typeof IntegrationAccount>;
type ApprovalPath = typeof PATH | typeof LEGACY_PATH;
type Review = { request: IntegrationRequest; accounts?: IntegrationAccount[]; accountId: string };
type Decision = "allow" | "deny" | "cancel";

function matchesRequest(first: IntegrationRequest, second: IntegrationRequest) {
  return first.id === second.id && first.service === second.service && first.action === second.action
    && first.expiresAt === second.expiresAt && JSON.stringify(first.params) === JSON.stringify(second.params);
}

function appName(service: string) {
  if (service === "github") return "GitHub";
  if (service === "gmail") return "Gmail";
  return service.split("_").map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
}

function visibleText(text: string) {
  // Preserve the exact values without letting text-direction controls obscure them.
  return text.replace(/\p{Bidi_Control}/gu, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

async function loadSnapshot(transport: ApiClient, endpoint: ApprovalPath, signal: AbortSignal, includeAccounts = false) {
  const response = await transport.get<unknown>(includeAccounts ? `${endpoint}?includeAccounts=1` : endpoint, {
    ...REQUEST_OPTIONS, signal,
  });
  return (endpoint === LEGACY_PATH ? LegacySnapshot : Snapshot).parse(response);
}

/** This panel is in the Matrix renderer, outside the hosted WebContentsView. */
export function HostedBotsIntegrationApproval({ transport }: { transport: ApiClient }) {
  const [requests, setRequests] = useState<IntegrationRequest[]>([]);
  const [review, setReview] = useState<Review>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const lifetime = useRef<AbortController | null>(null);
  const operation = useRef<AbortController | null>(null);
  const revision = useRef(0);
  const path = useRef<ApprovalPath>(PATH);

  useEffect(() => {
    path.current = PATH;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const stop = () => {
      clearTimeout(timer);
      lifetime.current?.abort();
      lifetime.current = null;
      operation.current = null;
    };
    async function poll(controller: AbortController) {
      const startedAtRevision = revision.current;
      let delay = POLL_INTERVAL;
      try {
        const response = await loadSnapshot(transport, path.current, controller.signal).catch((cause: unknown) => {
          // Earlier Preview bundles only expose the Drive approval route.
          if (controller.signal.aborted || path.current !== PATH || !(cause instanceof AppError) || cause.httpStatus !== 404) throw cause;
          path.current = LEGACY_PATH;
          return loadSnapshot(transport, LEGACY_PATH, controller.signal);
        });
        if (!controller.signal.aborted && startedAtRevision === revision.current) {
          setRequests(response.requests.filter((request) => request.expiresAt > Date.now()));
        }
      } catch (cause) {
        if (controller.signal.aborted) return;
        if (startedAtRevision === revision.current) setRequests([]);
        // Older preview bundles do not expose this optional feature.
        if (cause instanceof AppError && (cause.httpStatus === 403 || cause.httpStatus === 404)) return;
        delay = RETRY_INTERVAL;
      }
      if (!controller.signal.aborted && !stopped) timer = setTimeout(() => { void poll(controller); }, delay);
    }
    const syncVisibility = () => {
      if (document.visibilityState === "hidden") {
        stop();
        setRequests([]);
        setReview(undefined);
        setBusy(false);
        setError(undefined);
      } else if (!lifetime.current) {
        lifetime.current = new AbortController();
        void poll(lifetime.current);
      }
    };
    syncVisibility();
    document.addEventListener("visibilitychange", syncVisibility);
    return () => {
      stopped = true;
      document.removeEventListener("visibilitychange", syncVisibility);
      stop();
    };
  }, [transport]);

  async function perform(action: (signal: AbortSignal) => Promise<void>, failure: string) {
    const controller = lifetime.current;
    if (!controller || operation.current) return;
    operation.current = controller;
    setBusy(true);
    setError(undefined);
    try {
      await action(controller.signal);
    } catch (cause) {
      if (!controller.signal.aborted) {
        const finished = cause instanceof AppError && (cause.httpStatus === 404 || cause.httpStatus === 409);
        setError(finished ? "This integration request is no longer available." : failure);
      }
    } finally {
      if (operation.current === controller) {
        operation.current = null;
        setBusy(false);
      }
    }
  }

  function loadReview(request: IntegrationRequest) {
    if (operation.current || request.expiresAt <= Date.now()) return;
    setReview({ request, accountId: "" });
    void perform(async (signal) => {
      const result = await loadSnapshot(transport, path.current, signal, true);
      if (signal.aborted) return;
      if (!result.requests.some((current) => matchesRequest(current, request)
        && current.status === "pending" && current.expiresAt > Date.now())) {
        setRequests((current) => current.filter(({ id }) => id !== request.id));
        setReview(undefined);
        return;
      }
      const accounts = result.accounts.filter((account) => account.service === request.service);
      setReview({ request, accounts, accountId: "" });
    }, "Couldn’t load connected accounts.");
  }

  function decide(request: IntegrationRequest, decision: Decision) {
    if (request.expiresAt <= Date.now()) return;
    const accountId = review && matchesRequest(review.request, request)
      && review.accounts?.some(({ id }) => id === review.accountId) ? review.accountId : null;
    if (decision === "allow" && !accountId) return;
    void perform(async (signal) => {
      const endpoint = `${path.current}/${request.id}`;
      const options = { ...REQUEST_OPTIONS, signal };
      const result = decision === "cancel"
        ? await transport.delete<unknown>(endpoint, undefined, options)
        : await transport.post<unknown>(`${endpoint}/decision`, {
          decision, ...(decision === "allow" ? { accountId } : {}),
        }, options);
      z.strictObject({ ok: z.literal(true) }).parse(result);
      if (signal.aborted) return;
      revision.current++;
      setRequests((current) => decision === "allow"
        ? current.map((item) => item.id === request.id ? { ...item, status: "reading" } : item)
        : current.filter(({ id }) => id !== request.id));
      setReview(undefined);
    }, "Couldn’t update this integration request. Try again.");
  }

  if (requests.length === 0) return null;

  return (
    <section aria-label="Matrix integration approvals" className="ph-no-capture max-h-56 shrink-0 overflow-y-auto border-b px-3 py-2 text-sm"
      style={{ background: "var(--bg-overlay)", borderColor: "var(--border-subtle)", color: "var(--text-primary)" }}>
      {requests.map((request) => {
        const current = review && matchesRequest(review.request, request) ? review : null;
        const name = appName(request.service);
        const fileId = request.service === "google_drive" && request.action === "read_file"
          && Object.keys(request.params).length === 1 && typeof request.params.fileId === "string" ? request.params.fileId : null;
        return (
          <div key={request.id} className="space-y-2 py-1">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span role="status" className="font-medium">{request.status === "reading" ? `Reading from ${name}…` : `${name} read requested`}</span>
              {request.status === "reading" ? (
                <Button disabled={busy} onClick={() => decide(request, "cancel")}>Cancel read</Button>
              ) : !current ? (
                <Button disabled={busy} onClick={() => loadReview(request)}>Review {request.service === "google_drive" ? "Drive" : name} request</Button>
              ) : null}
            </div>
            {current || request.status === "reading" ? (
              <div className="min-w-0 space-y-1">
                <p>Action <code className="break-all">{request.action}</code></p>
                {fileId ? <p>Document ID <code className="break-all">{visibleText(fileId)}</code></p> : (
                  <>
                    <p>Parameters</p>
                    <pre className="whitespace-pre-wrap break-all">{visibleText(JSON.stringify(request.params, null, 2))}</pre>
                  </>
                )}
              </div>
            ) : null}
            {current && request.status === "pending" ? (
              <>
                <p style={{ color: "var(--text-secondary)" }}>Allow Bots to run this read once. The results will be shared with the requesting conversation and its AI model.</p>
                {current.accounts?.length ? (
                  <label className="flex flex-wrap items-center gap-2">
                    {name} account
                    <select value={current.accountId} disabled={busy}
                      className="max-w-full rounded-md border px-2 py-1"
                      style={{ background: "var(--bg-app)", borderColor: "var(--border-subtle)" }}
                      onChange={(event) => setReview({ ...current, accountId: event.currentTarget.value })}>
                      <option value="">Choose an account</option>
                      {current.accounts.map((account) => <option key={account.id} value={account.id}>{visibleText(account.label)}</option>)}
                    </select>
                  </label>
                ) : current.accounts ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <span>No connected {name} account.</span>
                    <Button disabled={busy} onClick={() => {
                      useUi.getState().requestSettingsSection("services");
                      useTabs.getState().openTab({ kind: "settings", title: "Connect Apps" });
                    }}>Open Connect Apps</Button>
                  </div>
                ) : busy ? <p role="status">Loading {name} accounts…</p> : null}
                <div className="flex flex-wrap gap-2">
                  <Button variant="primary" disabled={busy || !current.accountId} onClick={() => decide(request, "allow")}>Allow once</Button>
                  <Button disabled={busy} onClick={() => decide(request, "deny")}>Deny</Button>
                  <Button variant="ghost" disabled={busy} onClick={() => loadReview(request)}>Refresh accounts</Button>
                </div>
              </>
            ) : null}
          </div>
        );
      })}
      {error ? <p role="alert" className="mt-1" style={{ color: "var(--danger-text)" }}>{error}</p> : null}
    </section>
  );
}
