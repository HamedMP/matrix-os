import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod/v4";

import {
  SharedAppTransportError,
  type SharedAppFailureCode,
  type SharedAppTarget,
  type SharedAppTransport,
} from "./shared-app-transport.js";

const BridgeMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("matrix:shared-app:query"),
    requestId: z.string().min(8).max(128),
    action: z.json(),
  }).strict(),
  z.object({
    type: z.literal("matrix:shared-app:mutate"),
    requestId: z.string().min(8).max(128),
    expectedRevision: z.string().regex(/^\d+$/),
    action: z.json(),
  }).strict(),
]);

type ViewerState = "launching" | "ready" | SharedAppFailureCode;

export function SharedAppViewer({ target, transport }: {
  target: SharedAppTarget;
  transport: SharedAppTransport;
}) {
  const [entryUrl, setEntryUrl] = useState<string | null>(null);
  const [state, setState] = useState<ViewerState>("launching");
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const mounted = useRef(true);
  const title = `${displayName(target.appId)} shared by ${target.owner.displayName}`;

  const applyFailure = useCallback((error: unknown) => {
    const code = error instanceof SharedAppTransportError ? error.code : "unavailable";
    setState(code);
  }, []);

  const launch = useCallback(async (verifyHome = false) => {
    setState("launching");
    try {
      const launched = await transport.launch();
      if (verifyHome) await transport.query({ type: "refresh" });
      if (!mounted.current) return;
      setEntryUrl((current) => current ?? launched.entryUrl);
      setState("ready");
    } catch (error: unknown) {
      if (mounted.current) applyFailure(error);
    }
  }, [applyFailure, transport]);

  useEffect(() => {
    mounted.current = true;
    void launch();
    const unsubscribe = transport.subscribe({
      onChanged: async () => {
        try {
          await transport.query({ type: "refresh" });
          if (!mounted.current) return;
          setState("ready");
          iframeRef.current?.contentWindow?.postMessage({ type: "matrix:shared-app:changed" }, window.location.origin);
        } catch (error: unknown) {
          if (mounted.current) applyFailure(error);
        }
      },
      onUnavailable: () => { if (mounted.current) setState("host_offline"); },
    });
    return () => {
      mounted.current = false;
      unsubscribe();
      transport.close();
    };
  }, [applyFailure, launch, transport]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow
        || (event.origin !== window.location.origin && event.origin !== "null")) return;
      const parsed = BridgeMessageSchema.safeParse(event.data);
      if (!parsed.success) return;
      const request = parsed.data;
      const work = request.type === "matrix:shared-app:query"
        ? transport.query(request.action)
        : transport.mutate(request.action, request.expectedRevision);
      void work.then((result) => reply(event, request.requestId, { ok: true, result }))
        .catch((error: unknown) => {
          applyFailure(error);
          const failure = error instanceof SharedAppTransportError ? error : new SharedAppTransportError("unavailable", true);
          reply(event, request.requestId, { ok: false, code: failure.code, message: failure.message });
        });
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [applyFailure, transport]);

  const retryable = state === "host_offline" || state === "unavailable" || state === "uncertain";
  return <div className="relative h-full min-h-0 w-full overflow-hidden bg-[var(--bg-primary)]">
    {entryUrl ? <iframe ref={iframeRef} title={title} src={entryUrl}
      className="h-full w-full border-0" sandbox="allow-scripts allow-forms allow-modals allow-popups" /> : null}
    {state !== "ready" ? <div className="absolute inset-0 grid place-items-center bg-[color:var(--bg-primary)]/90 p-6">
      <section role={state === "launching" ? "status" : "alert"} className="max-w-sm rounded-2xl border bg-[var(--bg-primary)] p-6 text-center shadow-lg">
        <h1 className="font-semibold">{state === "launching" ? "Opening shared app…" : heading(state)}</h1>
        {state !== "launching" ? <p className="mt-2 text-sm text-[var(--text-secondary)]">{message(state)}</p> : null}
        {retryable ? <button type="button" className="mt-4 rounded-lg border px-3 py-2 text-sm" onClick={() => void launch(true)}>Retry</button> : null}
      </section>
    </div> : null}
  </div>;
}

function reply(event: MessageEvent, requestId: string, body: Record<string, unknown>): void {
  const source = event.source as Window | null;
  source?.postMessage({ type: "matrix:shared-app:response", requestId, ...body }, event.origin === "null" ? "*" : event.origin);
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
