import { useEffect, useRef, useState } from "react";
import { z } from "zod/v4";
import { AppError } from "../../../../shared/app-error";
import { Button } from "../../design/primitives";
import type { ApiClient } from "../../lib/api";
import { useTabs } from "../../stores/tabs";
import { useUi } from "../../stores/ui";

const PATH = "/api/hosted-bots/drive";
const POLL_INTERVAL = 2_000;
const RETRY_INTERVAL = 10_000;
const REQUEST_OPTIONS = { omitErrorBody: true, maxBytes: 16_384 };

const Requests = z.array(z.strictObject({
  id: z.uuid(),
  fileId: z.string().regex(/^[A-Za-z0-9_-]{1,256}$/),
  expiresAt: z.number().int().positive(),
  status: z.enum(["pending", "reading"]),
})).max(4);
const Accounts = z.array(z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/),
  label: z.string().min(1).max(100),
})).max(16);
const DriveApprovalSnapshot = z.strictObject({ requests: Requests, accounts: Accounts });

type DriveRequest = z.infer<typeof Requests>[number];
type Account = z.infer<typeof Accounts>[number];
type Review = Pick<DriveRequest, "id" | "fileId"> & { accounts?: Account[]; accountId: string };
type Decision = "allow" | "deny" | "cancel";

/** This panel is in the Matrix renderer, outside the hosted WebContentsView. */
export function HostedBotsDriveApproval({ transport }: { transport: ApiClient }) {
  const [requests, setRequests] = useState<DriveRequest[]>([]);
  const [review, setReview] = useState<Review>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const lifetime = useRef<AbortController | null>(null);
  const operation = useRef<AbortController | null>(null);
  const revision = useRef(0);

  useEffect(() => {
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
        const response = DriveApprovalSnapshot.parse(await transport.get<unknown>(PATH, {
          ...REQUEST_OPTIONS, signal: controller.signal,
        }));
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
        setError(finished ? "This Drive request is no longer available." : failure);
      }
    } finally {
      if (operation.current === controller) {
        operation.current = null;
        setBusy(false);
      }
    }
  }

  function loadReview(request: DriveRequest) {
    if (operation.current || request.expiresAt <= Date.now()) return;
    setReview({ id: request.id, fileId: request.fileId, accountId: "" });
    void perform(async (signal) => {
      const result = DriveApprovalSnapshot.parse(await transport.get<unknown>(`${PATH}?includeAccounts=1`, {
        ...REQUEST_OPTIONS, signal,
      }));
      if (signal.aborted) return;
      if (!result.requests.some((current) => current.id === request.id && current.fileId === request.fileId
        && current.status === "pending" && current.expiresAt > Date.now())) {
        setRequests((current) => current.filter(({ id }) => id !== request.id));
        setReview(undefined);
        return;
      }
      setReview({ id: request.id, fileId: request.fileId, accounts: result.accounts, accountId: "" });
    }, "Couldn’t load Google Drive accounts.");
  }

  function decide(request: DriveRequest, decision: Decision) {
    if (request.expiresAt <= Date.now()) return;
    const accountId = review?.id === request.id && review.fileId === request.fileId
      && review.accounts?.some(({ id }) => id === review.accountId) ? review.accountId : null;
    if (decision === "allow" && !accountId) return;
    void perform(async (signal) => {
      const endpoint = `${PATH}/${request.id}`;
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
    }, "Couldn’t update this Drive request. Try again.");
  }

  if (requests.length === 0) return null;

  return (
    <section aria-label="Matrix Google Drive approvals" className="ph-no-capture max-h-56 shrink-0 overflow-y-auto border-b px-3 py-2 text-sm"
      style={{ background: "var(--bg-overlay)", borderColor: "var(--border-subtle)", color: "var(--text-primary)" }}>
      {requests.map((request) => {
        const current = review?.id === request.id && review.fileId === request.fileId ? review : null;
        return (
          <div key={request.id} className="space-y-2 py-1">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span role="status" className="font-medium">{request.status === "reading" ? "Reading one Google Drive document…" : "Google Drive read requested"}</span>
              {request.status === "reading" ? (
                <Button disabled={busy} onClick={() => decide(request, "cancel")}>Cancel read</Button>
              ) : !current ? (
                <Button disabled={busy} onClick={() => loadReview(request)}>Review Drive request</Button>
              ) : null}
            </div>
            {current || request.status === "reading" ? <p>Document ID <code className="break-all">{request.fileId}</code></p> : null}
            {current && request.status === "pending" ? (
              <>
                <p style={{ color: "var(--text-secondary)" }}>Allow Bots to read this document once. Its contents will be shared with the requesting conversation.</p>
                {current.accounts?.length ? (
                  <label className="flex flex-wrap items-center gap-2">
                    Google Drive account
                    <select value={current.accountId} disabled={busy}
                      className="max-w-full rounded-md border px-2 py-1"
                      style={{ background: "var(--bg-app)", borderColor: "var(--border-subtle)" }}
                      onChange={(event) => setReview({ ...current, accountId: event.currentTarget.value })}>
                      <option value="">Choose an account</option>
                      {current.accounts.map((account) => <option key={account.id} value={account.id}>{account.label}</option>)}
                    </select>
                  </label>
                ) : current.accounts ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <span>No connected Google Drive account.</span>
                    <Button disabled={busy} onClick={() => {
                      useUi.getState().requestSettingsSection("services");
                      useTabs.getState().openTab({ kind: "settings", title: "Connect Apps" });
                    }}>Open Connect Apps</Button>
                  </div>
                ) : busy ? <p role="status">Loading Google Drive accounts…</p> : null}
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
