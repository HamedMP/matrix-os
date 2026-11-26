import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod/v4";

import { Button } from "../Button.js";
import {
  SharedAppTransportError,
  type SharedAppFailureCode,
  type SharedAppTarget,
  type SharedAppTransport,
} from "./shared-app-transport.js";

const BridgeMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("matrix:shared-app:ready"),
  }),
  z.strictObject({
    type: z.literal("matrix:shared-app:query"),
    requestId: z.string().min(8).max(128),
    action: z.json(),
  }),
  z.strictObject({
    type: z.literal("matrix:shared-app:mutate"),
    requestId: z.string().min(8).max(128),
    expectedRevision: z.string().regex(/^\d+$/),
    action: z.json(),
  }),
  z.strictObject({
    type: z.literal("matrix:shared-app:retry"),
    requestId: z.string().min(8).max(128),
  }),
  // ENG-579: `readData` of a view-only share; `action` carries the key.
  z.strictObject({
    type: z.literal("matrix:shared-app:read-data"),
    requestId: z.string().min(8).max(128),
    action: z.string().min(1).max(256),
  }),
  // ENG-579: the read-only bridge refused a write locally; show the view-only notice.
  z.strictObject({
    type: z.literal("matrix:shared-app:view-only"),
  }),
]);
const BRIDGE_READY_TIMEOUT_MS = 10_000;

type ViewerState = "launching" | "ready" | SharedAppFailureCode;

// react-doctor-disable-next-line react-doctor/no-high-complexity-react-function -- one viewer state machine (launch, bridge requests, recovery, view-only notice); request routing and the notice are already extracted helpers.
export function SharedAppViewer({ target, transport }: {
  target: SharedAppTarget;
  transport: SharedAppTransport;
}) {
  const targetKey = `${target.scopeId}:${target.buildId}:${target.shareRevision}`;
  const [entry, setEntry] = useState<{ targetKey: string; url: string } | null>(null);
  const [documentGeneration, setDocumentGeneration] = useState(0);
  const [state, setState] = useState<ViewerState>("launching");
  /** A refused write on a view-only share keeps the app open with an inline notice. */
  const [viewOnlyNotice, setViewOnlyNotice] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const mounted = useRef(true);
  const requestGeneration = useRef(0);
  const activeDocumentGeneration = useRef(0);
  const pendingMutationRecovery = useRef(false);
  const documentReady = useRef(false);
  const recovery = useRef<{ generation: number; promise: ReturnType<SharedAppTransport["retryMutation"]> } | null>(null);
  const entryUrl = entry?.targetKey === targetKey ? entry.url : null;
  const title = `${displayName(target.appId)} shared by ${target.owner.displayName}`;

  const applyFailure = useCallback((error: unknown) => {
    const code = error instanceof SharedAppTransportError ? error.code : "unavailable";
    if (code === "read_only") {
      // A refused write (or refused retry) is final: clear any pending recovery and keep the app open.
      pendingMutationRecovery.current = false;
      setState(documentReady.current ? "ready" : "launching");
      setViewOnlyNotice(true);
      return;
    }
    if (code === "uncertain") pendingMutationRecovery.current = true;
    if (code === "conflict" || code === "access_ended") pendingMutationRecovery.current = false;
    setState(pendingMutationRecovery.current ? "uncertain" : code);
  }, []);

  const launch = useCallback(async (verifyHome = false) => {
    const generation = ++requestGeneration.current;
    setState("launching");
    try {
      const launched = await transport.launch();
      if (verifyHome) await transport.query({ action: "appInfo", app: target.appId });
      if (!mounted.current || requestGeneration.current !== generation) return;
      activeDocumentGeneration.current += 1;
      pendingMutationRecovery.current = false;
      documentReady.current = false;
      setEntry({ targetKey, url: launched.entryUrl });
      setDocumentGeneration((value) => value + 1);
    } catch (error: unknown) {
      if (mounted.current && requestGeneration.current === generation) applyFailure(error);
    }
  }, [applyFailure, target.appId, targetKey, transport]);

  useEffect(() => {
    if (!entryUrl || state !== "launching") return;
    const generation = documentGeneration;
    const timer = window.setTimeout(() => {
      if (mounted.current && documentGeneration === generation && !documentReady.current) {
        applyFailure(new SharedAppTransportError("unavailable", true));
      }
    }, BRIDGE_READY_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [applyFailure, documentGeneration, entryUrl, state]);

  useEffect(() => {
    mounted.current = true;
    let active = true;
    void launch();
    const unsubscribe = transport.subscribe({
      onChanged: async () => {
        try {
          await transport.query({ action: "appInfo", app: target.appId });
          if (!active || !mounted.current) return;
          setState(pendingMutationRecovery.current ? "uncertain" : documentReady.current ? "ready" : "launching");
          iframeRef.current?.contentWindow?.postMessage({ type: "matrix:shared-app:changed" }, "*");
        } catch (error: unknown) {
          if (active && mounted.current) applyFailure(error);
        }
      },
      onUnavailable: () => {
        if (mounted.current) setState(pendingMutationRecovery.current ? "uncertain" : "host_offline");
      },
    });
    return () => {
      active = false;
      mounted.current = false;
      requestGeneration.current += 1;
      activeDocumentGeneration.current += 1;
      unsubscribe();
    };
  }, [applyFailure, launch, target.appId, transport]);

  // Both the app and the overlay recover the original operation, never a new mutation.
  const recoverMutation = useCallback(() => {
    const generation = activeDocumentGeneration.current;
    if (recovery.current?.generation === generation) return recovery.current.promise;
    const promise = Promise.resolve().then(() => transport.retryMutation()).then((result) => {
      if (mounted.current && activeDocumentGeneration.current === generation) {
        pendingMutationRecovery.current = false;
        setState(documentReady.current ? "ready" : "launching");
        iframeRef.current?.contentWindow?.postMessage({ type: "matrix:shared-app:changed" }, "*");
      }
      return result;
    }).finally(() => {
      if (recovery.current?.promise === promise) recovery.current = null;
    });
    recovery.current = { generation, promise };
    return promise;
  }, [transport]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow
        || (event.origin !== window.location.origin && event.origin !== "null")) return;
      const parsed = BridgeMessageSchema.safeParse(event.data);
      if (!parsed.success) return;
      const request = parsed.data;
      if (request.type === "matrix:shared-app:view-only") {
        setViewOnlyNotice(true);
        return;
      }
      if (request.type === "matrix:shared-app:ready") {
        documentReady.current = true;
        setState(pendingMutationRecovery.current ? "uncertain" : "ready");
        return;
      }
      const work = bridgeWork(transport, request, recoverMutation);
      const generation = activeDocumentGeneration.current;
      void work.then((result) => {
        if (mounted.current && activeDocumentGeneration.current === generation) reply(event, request.requestId, { ok: true, result });
      })
        .catch((error: unknown) => {
          if (!mounted.current || activeDocumentGeneration.current !== generation) return;
          const failure = error instanceof SharedAppTransportError ? error : new SharedAppTransportError("unavailable", true);
          // The overlay may already have confirmed this write. An empty retry queue
          // is for the app to reconcile, rather than a new conflicting edit.
          const alreadyRecovered = request.type === "matrix:shared-app:retry"
            && !pendingMutationRecovery.current && failure.code === "conflict";
          if (!alreadyRecovered) applyFailure(failure);
          reply(event, request.requestId, { ok: false, code: failure.code, message: failure.message });
        });
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [applyFailure, recoverMutation, transport]);

  const retry = useCallback(async () => {
    if (state !== "uncertain" && entryUrl && documentReady.current) {
      const generation = ++requestGeneration.current;
      try {
        await transport.query({ action: "appInfo", app: target.appId });
        if (!mounted.current || requestGeneration.current !== generation) return;
        setState("ready");
        iframeRef.current?.contentWindow?.postMessage({ type: "matrix:shared-app:changed" }, "*");
      } catch (error: unknown) {
        if (mounted.current && requestGeneration.current === generation) applyFailure(error);
      }
      return;
    }
    if (state !== "uncertain") {
      await launch(true);
      return;
    }
    const generation = ++requestGeneration.current;
    try {
      await recoverMutation();
    } catch (error: unknown) {
      if (mounted.current && requestGeneration.current === generation) applyFailure(error);
    }
  }, [applyFailure, entryUrl, launch, recoverMutation, state, target.appId, transport]);

  const retryable = state === "host_offline" || state === "unavailable" || state === "uncertain" || state === "conflict";
  return <div className="relative h-full min-h-0 w-full overflow-hidden bg-[var(--bg-primary)]">
    {entryUrl ? <iframe ref={iframeRef} key={`${targetKey}:${documentGeneration}`} title={title} src={entryUrl}
      onError={() => { documentReady.current = false; applyFailure(new SharedAppTransportError("unavailable", true)); }}
      className="h-full w-full border-0" sandbox="allow-scripts allow-forms allow-modals allow-popups" /> : null}
    {state !== "ready" ? <div className="absolute inset-0 grid place-items-center bg-[color:var(--bg-primary)]/90 p-6">
      <section role={state === "launching" ? "status" : "alert"} className="max-w-sm rounded-2xl border bg-[var(--bg-primary)] p-6 text-center shadow-lg">
        <h1 className="font-semibold">{state === "launching" ? "Opening shared app…" : heading(state)}</h1>
        {state !== "launching" ? <p className="mt-2 text-sm text-[var(--text-secondary)]">{message(state)}</p> : null}
        {retryable ? <button type="button" className="mt-4 rounded-lg border px-3 py-2 text-sm" onClick={() => void retry()}>
          {state === "conflict" ? "Review edit" : "Retry"}
        </button> : null}
      </section>
    </div> : null}
    <ViewOnlyNotice visible={viewOnlyNotice && state === "ready"} onDismiss={() => setViewOnlyNotice(false)} />
  </div>;
}

type BridgeRequest = Exclude<z.infer<typeof BridgeMessageSchema>, { type: "matrix:shared-app:ready" | "matrix:shared-app:view-only" }>;

function bridgeWork(
  transport: SharedAppTransport,
  request: BridgeRequest,
  recoverMutation: () => Promise<unknown>,
): Promise<unknown> {
  if (request.type === "matrix:shared-app:query") return transport.query(request.action);
  if (request.type === "matrix:shared-app:mutate") return transport.mutate(request.action, request.expectedRevision);
  if (request.type === "matrix:shared-app:read-data") return transport.readData(request.action);
  return recoverMutation();
}

/** ENG-579: a refused write on a view-only share; the app and the teammate's input stay in place. */
function ViewOnlyNotice({ visible, onDismiss }: { visible: boolean; onDismiss: () => void }) {
  if (!visible) return null;
  return <div role="status" className="absolute inset-x-3 bottom-3 flex items-center gap-3 rounded-xl border bg-[var(--bg-primary)] px-4 py-3 text-sm shadow-lg">
    <span className="min-w-0 flex-1">This app is view-only. Ask the owner to make it collaborative.</span>
    <Button type="button" variant="secondary" size="sm" onClick={onDismiss}>Dismiss</Button>
  </div>;
}

function reply(event: MessageEvent, requestId: string, body: Record<string, unknown>): void {
  const source = event.source as Window | null;
  source?.postMessage({ type: "matrix:shared-app:response", requestId, ...body }, "*");
}

function displayName(appId: string): string {
  return appId.replaceAll(/[-_]+/g, " ").replace(/^./, (value) => value.toUpperCase());
}

function heading(state: Exclude<ViewerState, "launching" | "ready">): string {
  if (state === "access_ended") return "Access ended";
  if (state === "needs_recheck") return "Owner action needed";
  if (state === "conflict") return "The app changed";
  if (state === "uncertain") return "Change not confirmed";
  if (state === "host_offline") return "Owner computer offline";
  return "Shared app unavailable";
}

function message(state: Exclude<ViewerState, "launching" | "ready">): string {
  if (state === "access_ended") return "Access to this shared app has ended.";
  if (state === "needs_recheck") return "The owner needs to check this app again before it can open.";
  if (state === "conflict") return "Your local input is still here. Review it before trying the change again.";
  if (state === "uncertain") return "Your input is still here. Retry to confirm the same change without duplicating it.";
  if (state === "host_offline") return "The owner’s computer is offline. This app will stay open while you retry.";
  return "Shared app is unavailable. Try again.";
}
