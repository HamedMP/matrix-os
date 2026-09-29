import {
  CollaborationAppActionResponseSchema, CollaborationAppInstanceSchema, CollaborationAppRootSchema,
  CollaborationScopeSchema, CollaborationAppInstanceIdSchema, type CollaborationAppInstance,
} from "@matrix-os/contracts";
import { useEffect, useRef, useState } from "react";
import { z } from "zod/v4";
import type { CollaborationApi } from "./ChatCollaboratorsDialog.js";
import { classifySharedFileFailure } from "./recipient-views.js";
import { buildSharedAppDocument, SharedAppMessageSchema, SHARED_APP_READ_ACTIONS, SHARED_APP_WRITE_ACTIONS } from "./shared-app-bridge.js";

type State =
  | { status: "loading" }
  | { status: "unavailable"; reason: string }
  | { status: "ready"; html: string; role: "owner" | "editor" | "viewer"; instance: CollaborationAppInstance };

const ViewResponseSchema = z.strictObject({ result: z.json() });
const MAX_MESSAGE_BYTES = 256 * 1024;

/** Recipient app view: the scope's catalog root chooses the only instance this frame can reach. */
export function SharedAppView({ api, scopeId, appId }: { api: CollaborationApi; scopeId: string; appId?: string }) {
  const [state, setState] = useState<State>({ status: "loading" });
  useEffect(() => {
    let active = true;
    // react-doctor-disable-next-line react-doctor/no-fetch-in-effect -- the direct API fetch is scoped to this view; cleanup fences stale results.
    void (async () => {
      try {
        const base = `/api/collaboration/scopes/${encodeURIComponent(scopeId)}`;
        const scope = CollaborationScopeSchema.parse(await api.get(base));
        if (appId ? scope.kind !== "project" : scope.kind !== "app") throw new Error("Scope kind mismatch");
        const root = appId ? null : CollaborationAppRootSchema.parse(await api.get(`${base}/apps`));
        if (root && root.catalogId !== scope.resourceId) throw new Error("App root mismatch");
        const selectedAppId = CollaborationAppInstanceIdSchema.parse(appId ?? root?.appId);
        const instance = CollaborationAppInstanceSchema.parse(await api.get(`${base}/apps/${encodeURIComponent(selectedAppId)}`));
        if (instance.appId !== selectedAppId || (root && instance.catalogId !== root.catalogId)) throw new Error("App instance mismatch");
        if (instance.readiness !== "ready" || instance.collaborationMode !== "scoped") {
          if (active) setState({ status: "unavailable", reason: instance.readiness === "blocked" ? "blocked" : "unsupported" });
          return;
        }
        const html = await buildSharedAppDocument(api, scopeId, instance.appId, scope.role);
        if (active) setState({ status: "ready", html, role: scope.role, instance });
      } catch (error: unknown) {
        console.warn("[shared-app] load failed", error instanceof Error ? error.name : "UnknownError");
        if (active) setState({ status: "unavailable", reason: classifySharedFileFailure(error) });
      }
    })();
    return () => { active = false; };
  }, [api, scopeId, appId]);

  if (state.status === "loading") return <p role="status" className="p-8">Loading shared app…</p>;
  if (state.status === "unavailable") return <div role="alert" data-reason={state.reason} className="m-auto max-w-lg rounded-2xl border p-8 text-center">
    <h1 className="text-lg font-medium">App unavailable</h1>
    <p className="mt-2 text-sm">{state.reason === "blocked" ? "The owner has blocked this app." : state.reason === "host_offline"
      ? "The owner's computer is offline. Try again later." : state.reason === "access_removed"
        ? "Your access may have changed." : "This app cannot be opened in a shared view."}</p>
  </div>;
  return <ReadyAppFrame key={`${scopeId}:${state.instance.appId}`} api={api} scopeId={scopeId} {...state} />;
}

function ReadyAppFrame({ api, scopeId, html, role, instance }: {
  api: CollaborationApi; scopeId: string; html: string; role: "owner" | "editor" | "viewer"; instance: CollaborationAppInstance;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const documentPort = useRef<MessagePort | null>(null);
  const loadCount = useRef(0);
  const revision = useRef(instance.revision);
  const writing = useRef(false);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    if (!api.subscribe) return;
    let active = true;
    const path = `/api/collaboration/scopes/${encodeURIComponent(scopeId)}/apps/${encodeURIComponent(instance.appId)}`;
    const stop = api.subscribe(scopeId, async () => {
      try {
        const current = CollaborationAppInstanceSchema.parse(await api.get(path));
        if (!active) return;
        if (current.appId !== instance.appId || current.catalogId !== instance.catalogId
          || current.readiness !== "ready" || current.collaborationMode !== "scoped") {
          setUnavailable(true);
          return;
        }
        revision.current = current.revision;
        documentPort.current?.postMessage({ type: "matrix:app-changed", scopeId, appId: instance.appId });
      } catch (error: unknown) {
        console.warn("[shared-app] refresh failed", error instanceof Error ? error.name : "UnknownError");
        if (active) setUnavailable(true);
      }
    }, () => { if (active) setUnavailable(true); });
    return () => { active = false; stop(); };
  }, [api, scopeId, instance.appId, instance.catalogId]);

  useEffect(() => {
    let active = true;
    const path = `/api/collaboration/scopes/${encodeURIComponent(scopeId)}/apps/${encodeURIComponent(instance.appId)}`;
    const onRequest = (event: MessageEvent, port: MessagePort) => {
      if (!active || port !== documentPort.current) return;
      const message = SharedAppMessageSchema.safeParse(event.data);
      if (!message.success || message.data.scopeId !== scopeId || message.data.appId !== instance.appId) return;
      let size: number;
      try { size = new TextEncoder().encode(JSON.stringify(message.data)).byteLength; }
      catch (error: unknown) {
        console.warn("[shared-app] invalid request body", error instanceof Error ? error.name : "UnknownError");
        return;
      }
      if (size > MAX_MESSAGE_BYTES) return;
      const action = message.data.action;
      const reply = (value: { ok: true; result: unknown } | { ok: false; error: string }) => {
        if (active && port === documentPort.current) port.postMessage({ type: "matrix:app-result", id: message.data.id, ...value });
      };
      if (!action || typeof action !== "object" || Array.isArray(action) || !("app" in action)
        || action.app !== instance.appId || !("action" in action) || typeof action.action !== "string") return;
      const read = SHARED_APP_READ_ACTIONS.has(action.action);
      const write = SHARED_APP_WRITE_ACTIONS.has(action.action);
      if (!read && !write) return;
      if (write && (role === "viewer" || writing.current)) {
        reply({ ok: false, error: "Action unavailable" });
        return;
      }
      if (write) writing.current = true;
      void (async () => {
        try {
          if (read) {
            const result = ViewResponseSchema.parse(await api.post(`${path}/view`, { action })).result;
            reply({ ok: true, result });
          } else {
            const result = CollaborationAppActionResponseSchema.parse(await api.post(`${path}/actions`, {
              action, expectedRevision: revision.current, clientRequestId: crypto.randomUUID(),
            }));
            if (active) revision.current = String(result.revision);
            reply({ ok: true, result: result.result });
            if (active && port === documentPort.current) port.postMessage({
              type: "matrix:app-changed", scopeId, appId: instance.appId,
              table: "table" in action && typeof action.table === "string" ? action.table : undefined,
            });
          }
        } catch (error: unknown) {
          console.warn("[shared-app] bridge request failed", error instanceof Error ? error.name : "UnknownError");
          reply({ ok: false, error: "Action unavailable" });
        } finally {
          if (write) writing.current = false;
        }
      })();
    };
    const onReady = (event: MessageEvent) => {
      if (documentPort.current || event.source !== frame.current?.contentWindow || event.origin !== "null"
        || event.data?.type !== "matrix:app-bridge-ready" || event.data.scopeId !== scopeId
        || event.data.appId !== instance.appId || !event.ports[0]) return;
      const port = event.ports[0];
      documentPort.current = port;
      port.onmessage = (message) => onRequest(message, port);
      port.start?.();
    };
    window.addEventListener("message", onReady);
    return () => {
      active = false;
      window.removeEventListener("message", onReady);
      documentPort.current?.close();
      documentPort.current = null;
    };
  }, [api, scopeId, instance.appId, role]);

  if (unavailable) return <div role="alert" className="m-auto max-w-lg rounded-2xl border p-8 text-center">
    <h1 className="text-lg font-medium">App unavailable</h1>
    <p className="mt-2 text-sm">This shared app changed or your access may have changed. Refresh to try again.</p>
  </div>;
  return <section className="flex min-h-0 h-full flex-col" aria-label="Shared app view">
    <header className="flex items-center justify-between border-b px-4 py-2 text-sm">
      <span className="font-medium">{instance.appId}</span><span>{role === "viewer" ? "Viewer · read only" : role === "editor" ? "Contributor" : "Owner"}</span>
    </header>
    <iframe ref={frame} title="Shared app" sandbox="allow-scripts" srcDoc={html}
      onLoad={() => {
        loadCount.current += 1;
        if (loadCount.current > 1) {
          documentPort.current?.close();
          documentPort.current = null;
          setUnavailable(true);
        }
      }} className="min-h-0 w-full flex-1 border-0" />
  </section>;
}
