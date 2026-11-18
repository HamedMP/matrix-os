import { useEffect, useRef, useState } from "react";
import { z } from "zod/v4";
import { AppError } from "../../../../shared/app-error";
import { Button } from "../../design/primitives";
import type { ApiClient } from "../../lib/api";

const listPath = "/api/hosted-bots/integrations/mcp";
const decisionsPath = "/api/chats/hosted-bots/runs";
const requestOptions = { omitErrorBody: true, maxBytes: 32 * 1024 };
const requestSchema = z.strictObject({
  id: z.uuid(),
  runId: z.templateLiteral(["hosted-bots-", z.uuid()]),
  serverId: z.uuid(),
  server: z.string().min(1).max(100),
  tool: z.string().min(1).max(128),
  params: z.record(z.string(), z.json()),
  expiresAt: z.number().int().positive(),
  status: z.enum(["pending", "reading"]),
});
const snapshotSchema = z.strictObject({ requests: z.array(requestSchema).max(4) });
type Approval = z.infer<typeof requestSchema>;
type Decision = "approve" | "decline" | "cancel";

function approvalKey(approval: Approval): string {
  return JSON.stringify([approval.runId, approval.id, approval.serverId, approval.server, approval.tool, approval.params, approval.expiresAt]);
}

function reviewText(value: string): string {
  return value.replace(/\p{Bidi_Control}/gu, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** Render the Matrix owner's approval outside the upstream WebContentsView. */
export function HostedBotsMcpApproval({ transport }: { transport: ApiClient }) {
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [review, setReview] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const lifetime = useRef<AbortController | null>(null);
  const pending = useRef<AbortController | null>(null);
  const revision = useRef(0);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll(controller: AbortController) {
      const requestedRevision = revision.current;
      let delay = 2_000;
      try {
        const data = await transport.get<unknown>(listPath, { ...requestOptions, signal: controller.signal });
        const { requests } = snapshotSchema.parse(data);
        if (!controller.signal.aborted && revision.current === requestedRevision) {
          setApprovals(requests.filter((request) => request.expiresAt > Date.now()));
        }
      } catch (cause) {
        if (controller.signal.aborted) return;
        if (revision.current === requestedRevision) setApprovals([]);
        if (cause instanceof AppError && (cause.httpStatus === 403 || cause.httpStatus === 404)) return;
        delay = 10_000;
      }
      if (!controller.signal.aborted) timer = setTimeout(() => { void poll(controller); }, delay);
    }
    const stop = () => {
      clearTimeout(timer);
      lifetime.current?.abort();
      lifetime.current = null;
      pending.current = null;
    };
    const syncVisibility = () => {
      if (document.visibilityState === "hidden") {
        stop();
        setApprovals([]);
        setReview(undefined);
        setBusy(false);
        setError(undefined);
      } else if (!lifetime.current) {
        const controller = new AbortController();
        lifetime.current = controller;
        void poll(controller);
      }
    };
    syncVisibility();
    document.addEventListener("visibilitychange", syncVisibility);
    return () => {
      document.removeEventListener("visibilitychange", syncVisibility);
      stop();
    };
  }, [transport]);

  async function decide(approval: Approval, decision: Decision) {
    const controller = lifetime.current;
    if (!controller || pending.current || approval.expiresAt <= Date.now()
      || (decision !== "cancel" && (approval.status !== "pending" || review !== approvalKey(approval)))) return;
    pending.current = controller;
    setBusy(true);
    setError(undefined);
    try {
      const result = await transport.post<unknown>(`${decisionsPath}/${approval.runId}/approvals/${approval.id}`, {
        decision, clientRequestId: `req_${crypto.randomUUID()}`,
      }, { ...requestOptions, signal: controller.signal });
      z.strictObject({ ok: z.literal(true) }).parse(result);
      if (controller.signal.aborted) return;
      revision.current++;
      setApprovals((current) => decision === "approve"
        ? current.map((item) => item.id === approval.id ? { ...item, status: "reading" } : item)
        : current.filter((item) => item.id !== approval.id));
      setReview(undefined);
    } catch (cause) {
      if (controller.signal.aborted) return;
      const finished = cause instanceof AppError && (cause.httpStatus === 404 || cause.httpStatus === 409);
      setError(finished ? "This MCP request is no longer available." : "Couldn’t update this MCP request. Try again.");
    } finally {
      if (pending.current === controller) {
        pending.current = null;
        setBusy(false);
      }
    }
  }

  if (!approvals.length) return null;
  return (
    <section aria-label="Matrix MCP approvals" className="ph-no-capture max-h-56 shrink-0 overflow-y-auto border-b px-3 py-2 text-sm"
      style={{ background: "var(--bg-overlay)", borderColor: "var(--border-subtle)", color: "var(--text-primary)" }}>
      {approvals.map((item) => {
        const reviewed = review === approvalKey(item);
        const active = item.status === "reading";
        return (
          <div key={item.id} className="space-y-2 py-1">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span role="status" className="font-medium">{active ? "Running MCP tool" : "MCP tool requested"} · {reviewText(item.server)}</span>
              {active ? <Button disabled={busy} onClick={() => void decide(item, "cancel")}>Cancel tool call</Button>
                : !reviewed ? <Button disabled={busy} onClick={() => setReview(approvalKey(item))}>Review MCP request</Button> : null}
            </div>
            {reviewed || active ? <div className="min-w-0 space-y-1">
              <p>Tool <code className="break-all">{reviewText(item.tool)}</code></p>
              <p>Parameters</p>
              <pre className="whitespace-pre-wrap break-all">{reviewText(JSON.stringify(item.params, null, 2))}</pre>
            </div> : null}
            {reviewed && !active ? <div className="space-y-2">
              <p style={{ color: "var(--text-secondary)" }}>Allow this tool call once. The requesting Bot and its model can see the result.</p>
              <div className="flex flex-wrap gap-2">
                <Button variant="primary" disabled={busy} onClick={() => void decide(item, "approve")}>Allow once</Button>
                <Button disabled={busy} onClick={() => void decide(item, "decline")}>Deny</Button>
              </div>
            </div> : null}
          </div>
        );
      })}
      {error ? <p role="alert" className="mt-1" style={{ color: "var(--danger-text)" }}>{error}</p> : null}
    </section>
  );
}
