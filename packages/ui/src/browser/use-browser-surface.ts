import { useEffect, useRef, useState } from "react";
import { browserEndpoint, browserRequest, browserStatus, browserViewerMessage, productViewerUrl } from "./transport.js";
import { browserAutomationActionAllowed, browserHumanInputAllowed, browserStatusIsCurrent } from "./automation-state.js";
import type { BrowserAutomationAction, BrowserControlAction, BrowserSurfaceProps, BrowserSurfaceState } from "./types.js";

const empty = (scope: string, active: boolean): BrowserSurfaceState => ({ scope, status: null,
  connection: active ? "connecting" : "inactive", viewerUrl: "", busy: false, error: "" });
const report = (error: unknown) => console.warn("[browser] Request unavailable", error instanceof Error
  && ["Error", "TypeError", "AbortError", "TimeoutError", "ZodError", "SyntaxError"].includes(error.name) ? error.name : "unknown");

export function useBrowserSurface({ gatewayUrl, surface, active = true, ensureSession }: BrowserSurfaceProps) {
  const [revision, setRevision] = useState(0);
  const scope = JSON.stringify([gatewayUrl, surface, revision]);
  const [state, setState] = useState<BrowserSurfaceState>(() => empty(scope, active));
  const iframe = useRef<HTMLIFrameElement>(null);
  const lifetime = useRef<{ scope: string; controller: AbortController; mutation: boolean; mutationRevision: number; connection: BrowserSurfaceState["connection"]; status: BrowserSurfaceState["status"] } | null>(null);

  useEffect(() => {
    setState(empty(scope, active));
    if (!active) return;
    const controller = new AbortController();
    const owner: NonNullable<typeof lifetime.current> = { scope, controller, mutation: false, mutationRevision: 0, connection: "connecting", status: null }; lifetime.current = owner;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    let connectionTimer: ReturnType<typeof setTimeout> | undefined;
    let refreshAt = 0;
    let admitted = false;
    let endpoint: ReturnType<typeof browserEndpoint>;
    const current = () => !controller.signal.aborted && lifetime.current === owner;
    const update = (patch: Partial<BrowserSurfaceState>) => {
      if (!current()) return;
      if (patch.connection !== undefined) owner.connection = patch.connection;
      if (patch.status !== undefined) owner.status = patch.status;
      setState(previous => previous.scope === scope ? { ...previous, ...patch } : previous);
    };
    const session = async () => {
      if (Date.now() < refreshAt) return;
      await ensureSession(controller.signal);
      // Hosted callers may skip renewal when their existing cookie is still valid.
      // Recheck soon enough to reach their original renewal boundary after reactivation.
      controller.signal.throwIfAborted(); refreshAt = Date.now() + 60_000;
    };
    const fail = () => update({ connection: "unavailable", viewerUrl: "", error: "Your Matrix computer’s browser is unavailable. Reconnect to try again." });
    const poll = async () => {
      const mutationRevision = owner.mutationRevision;
      try {
        if (owner.mutation) return;
        await session(); if (!current()) return;
        const status = browserStatus(await browserRequest(endpoint.appBase, "browser-status", controller.signal));
        if (current() && !owner.mutation && mutationRevision === owner.mutationRevision && browserStatusIsCurrent(status, owner.status)) {
          update({ status }); if (!status.available) fail();
        }
      } catch (error) { if (current() && !owner.mutation && mutationRevision === owner.mutationRevision) { report(error); fail(); } }
      finally { if (current()) pollTimer = setTimeout(() => { void poll(); }, 4000); }
    };
    const onMessage = (event: MessageEvent) => {
      if (!current() || !endpoint || event.origin !== endpoint.origin || !iframe.current || event.source !== iframe.current.contentWindow) return;
      const connected = browserViewerMessage(event.data); if (connected === null) return;
      // The installed client announces its initial state before the RFB handshake.
      if (!connected && !admitted) return;
      if (connected) admitted = true;
      if (connectionTimer) clearTimeout(connectionTimer);
      update(connected ? { connection: "connected", error: "" } : { connection: "disconnected", viewerUrl: "" });
    };
    window.addEventListener("message", onMessage);
    void (async () => {
      try {
        endpoint = browserEndpoint(gatewayUrl);
        await session(); if (!current()) return;
        const initial = browserStatus(await browserRequest(endpoint.appBase, "browser-status", controller.signal));
        update({ status: initial });
        if (!current()) return;
        if (!initial.available) { fail(); return; }
        const ticket = await browserRequest(endpoint.appBase, "browser-session", controller.signal, { surface });
        if (!current()) return;
        const status = browserStatus(await browserRequest(endpoint.appBase, "browser-status", controller.signal));
        if (!current()) return;
        if (!status.available || !browserStatusIsCurrent(status, owner.status)) { fail(); return; }
        update({ status, viewerUrl: productViewerUrl(endpoint, ticket) });
        connectionTimer = setTimeout(() => update({ connection: "disconnected", viewerUrl: "" }), 15_000);
        pollTimer = setTimeout(() => { void poll(); }, 4000);
      } catch (error) { if (current()) { report(error); fail(); } }
    })();
    return () => {
      controller.abort(); if (pollTimer) clearTimeout(pollTimer); if (connectionTimer) clearTimeout(connectionTimer);
      window.removeEventListener("message", onMessage);
      if (lifetime.current === owner) lifetime.current = null;
    };
  }, [gatewayUrl, surface, active, scope, ensureSession]);

  const control = async (action: BrowserControlAction): Promise<boolean> => {
    const owner = lifetime.current;
    const acknowledged = () => owner?.connection === "connected" && browserHumanInputAllowed(owner.status);
    if (!active || !owner || owner.scope !== scope || owner.controller.signal.aborted || owner.mutation || !acknowledged()) return false;
    owner.mutation = true; owner.mutationRevision++;
    const current = () => !owner.controller.signal.aborted && lifetime.current === owner;
    setState(previous => ({ ...previous, busy: true, error: "" }));
    try {
      await ensureSession(owner.controller.signal); if (!current() || !acknowledged()) return false;
      const endpoint = browserEndpoint(gatewayUrl);
      const status = browserStatus(await browserRequest(endpoint.appBase, "browser-control", owner.controller.signal, { action }));
      if (!current()) return false;
      if (!browserStatusIsCurrent(status, owner.status)) throw new Error("Stale browser status");
      owner.status = status;
      setState(previous => ({ ...previous, status })); return true;
    } catch (error) {
      if (current()) { report(error); setState(previous => ({ ...previous, error: "That action could not be completed. Try again." })); }
      return false;
    } finally {
      owner.mutation = false;
      if (current()) setState(previous => ({ ...previous, busy: false }));
    }
  };
  const automationControl = async (action: BrowserAutomationAction): Promise<boolean> => {
    const owner = lifetime.current;
    const acknowledged = () => owner?.connection === "connected" && browserAutomationActionAllowed(owner.status, action);
    if (!active || !owner || owner.scope !== scope || owner.controller.signal.aborted || owner.mutation || !acknowledged()) return false;
    owner.mutation = true; owner.mutationRevision++;
    const current = () => !owner.controller.signal.aborted && lifetime.current === owner;
    setState(previous => previous.scope === scope ? { ...previous, busy: true, automationAction: action, error: "" } : previous);
    try {
      await ensureSession(owner.controller.signal);
      if (!current() || !acknowledged()) return false;
      const endpoint = browserEndpoint(gatewayUrl);
      const status = browserStatus(await browserRequest(endpoint.appBase, "browser-automation", owner.controller.signal, { action }));
      if (!current()) return false;
      if (!browserStatusIsCurrent(status, owner.status)) throw new Error("Stale browser status");
      owner.status = status;
      setState(previous => previous.scope === scope ? { ...previous, status } : previous);
      return true;
    } catch (error) {
      if (current()) {
        report(error);
        // A failed drain or resume never grants human control optimistically.
        if (owner.status) owner.status = { ...owner.status, humanControlAvailable: false };
        setState(previous => previous.scope === scope ? { ...previous, status: owner.status, error: "Browser control could not be changed. Try again." } : previous);
      }
      return false;
    } finally {
      owner.mutation = false;
      if (current()) setState(previous => previous.scope === scope ? { ...previous, busy: false, automationAction: undefined } : previous);
    }
  };
  return { state: state.scope === scope && active ? state : empty(scope, active), iframe,
    viewerKey: scope, reconnect: () => { if (active) setRevision(value => value + 1); }, control, automationControl };
}
