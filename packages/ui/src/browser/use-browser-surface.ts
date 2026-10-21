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
  const [viewerRevision, setViewerRevision] = useState(0);
  const scope = JSON.stringify([gatewayUrl, surface, revision]);
  // Activation gates input, not the lifetime of an already-open viewer.
  const [startedScope, setStartedScope] = useState(active ? scope : "");
  const enabled = active || startedScope === scope;
  const focus = useRef({ active, epoch: 0 });
  if (focus.current.active !== active) focus.current = { active, epoch: focus.current.epoch + 1 };
  const wake = useRef<(() => void) | null>(null);
  useEffect(() => { if (active) setStartedScope(scope); }, [active, scope]);
  const [state, setState] = useState<BrowserSurfaceState>(() => empty(scope, active));
  const iframe = useRef<HTMLIFrameElement>(null);
  const lifetime = useRef<{ scope: string; controller: AbortController; mutation: boolean; mutationRevision: number; connection: BrowserSurfaceState["connection"]; status: BrowserSurfaceState["status"]; statusEpoch: number } | null>(null);

  useEffect(() => {
    setState(empty(scope, enabled));
    if (!enabled) return;
    const controller = new AbortController();
    const owner: NonNullable<typeof lifetime.current> = { scope, controller, mutation: false, mutationRevision: 0, connection: "connecting", status: null, statusEpoch: -1 }; lifetime.current = owner;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    let connectionTimer: ReturnType<typeof setTimeout> | undefined;
    let refreshAt = 0;
    let admitted = false;
    let expectedViewerUrl = "";
    let viewerRefreshAt = 0;
    let polling = false, wakeRequested = false;
    let endpoint: ReturnType<typeof browserEndpoint>;
    const current = () => !controller.signal.aborted && lifetime.current === owner;
    const update = (patch: Partial<BrowserSurfaceState>, statusEpoch = -1) => {
      if (!current()) return;
      if (patch.connection !== undefined) owner.connection = patch.connection;
      if (patch.status !== undefined) { owner.status = patch.status; owner.statusEpoch = statusEpoch; }
      setState(previous => previous.scope === scope ? { ...previous, ...patch } : previous);
    };
    const session = async () => {
      if (Date.now() < refreshAt) return;
      await ensureSession(controller.signal);
      controller.signal.throwIfAborted(); refreshAt = Date.now() + 60_000;
    };
    const fail = () => {
      expectedViewerUrl = ""; viewerRefreshAt = 0;
      if (connectionTimer) clearTimeout(connectionTimer);
      update({ connection: "unavailable", viewerUrl: "", error: "Your Matrix computer’s browser is unavailable. Reconnect to try again." });
    };
    const openViewer = async () => {
      if (!focus.current.active) return;
      expectedViewerUrl = ""; viewerRefreshAt = 0; admitted = false;
      if (connectionTimer) clearTimeout(connectionTimer);
      update({ connection: "connecting", viewerUrl: "", error: "" });
      setViewerRevision(value => value + 1);
      // Stream authority is fixed at admission. A cached cookie may be near
      // expiry, so every claim starts with a freshly renewed owner session.
      await ensureSession(controller.signal, { force: true });
      if (!current() || !focus.current.active) return;
      refreshAt = Date.now() + 60_000;
      const initialEpoch = focus.current.epoch;
      const initial = browserStatus(await browserRequest(endpoint.appBase, "browser-status", controller.signal));
      if (!current() || !focus.current.active) return;
      if (!initial.available || !browserStatusIsCurrent(initial, owner.status)) { fail(); return; }
      update({ status: initial }, initialEpoch);
      const ticket = await browserRequest(endpoint.appBase, "browser-session", controller.signal, { surface });
      if (!current() || !focus.current.active) return;
      const statusEpoch = focus.current.epoch;
      const status = browserStatus(await browserRequest(endpoint.appBase, "browser-status", controller.signal));
      if (!current() || !focus.current.active) return;
      if (!status.available || !browserStatusIsCurrent(status, owner.status)) { fail(); return; }
      expectedViewerUrl = productViewerUrl(endpoint, ticket);
      update({ status, viewerUrl: expectedViewerUrl }, statusEpoch);
      // Reclaim before the ten-minute cookie/stream expiry, not the ticket's
      // shorter handshake window. Only a fresh RFB acknowledgement allows input.
      viewerRefreshAt = Date.now() + 8 * 60_000;
      connectionTimer = setTimeout(() => {
        expectedViewerUrl = ""; viewerRefreshAt = 0;
        update({ connection: "disconnected", viewerUrl: "" });
      }, 15_000);
    };
    const poll = async (returning = false) => {
      if (!current()) return;
      if (polling) { wakeRequested ||= returning; return; }
      if (pollTimer) clearTimeout(pollTimer);
      polling = true;
      const statusEpoch = focus.current.epoch;
      const mutationRevision = owner.mutationRevision;
      try {
        if (!focus.current.active || owner.mutation) return;
        if ((owner.connection === "connecting" && !expectedViewerUrl)
          || (returning && ["disconnected", "unavailable"].includes(owner.connection))) {
          await openViewer(); return;
        }
        if (owner.connection === "connected" && viewerRefreshAt && Date.now() >= viewerRefreshAt) {
          await openViewer(); return;
        }
        await session(); if (!current()) return;
        const status = browserStatus(await browserRequest(endpoint.appBase, "browser-status", controller.signal));
        if (current() && !owner.mutation && mutationRevision === owner.mutationRevision && browserStatusIsCurrent(status, owner.status)) {
          update({ status }, statusEpoch); if (!status.available) fail();
        }
      } catch (error) { if (current() && !owner.mutation && mutationRevision === owner.mutationRevision) { report(error); fail(); } }
      finally {
        polling = false;
        if (current()) {
          const returning = wakeRequested; wakeRequested = false;
          pollTimer = setTimeout(() => { void poll(returning); }, returning ? 0 : 4000);
        }
      }
    };
    const onMessage = (event: MessageEvent) => {
      if (!current() || !endpoint || event.origin !== endpoint.origin || !iframe.current || !expectedViewerUrl || iframe.current.src !== expectedViewerUrl || event.source !== iframe.current.contentWindow) return;
      const connected = browserViewerMessage(event.data); if (connected === null) return;
      // The installed client announces its initial state before the RFB handshake.
      if (!connected && !admitted) return;
      if (connected) admitted = true;
      if (connectionTimer) clearTimeout(connectionTimer);
      if (!connected) { expectedViewerUrl = ""; viewerRefreshAt = 0; }
      update(connected ? { connection: "connected", error: "" } : { connection: "disconnected", viewerUrl: "" });
    };
    window.addEventListener("message", onMessage);
    const resume = () => { void poll(true); };
    wake.current = resume;
    try { endpoint = browserEndpoint(gatewayUrl); void poll(); }
    catch (error) { report(error); fail(); }
    return () => {
      controller.abort(); if (pollTimer) clearTimeout(pollTimer); if (connectionTimer) clearTimeout(connectionTimer);
      window.removeEventListener("message", onMessage);
      if (lifetime.current === owner) lifetime.current = null;
      if (wake.current === resume) wake.current = null;
    };
  }, [gatewayUrl, surface, enabled, scope, revision, ensureSession]);

  useEffect(() => { if (active) wake.current?.(); }, [active, scope]);

  const control = async (action: BrowserControlAction): Promise<boolean> => {
    const owner = lifetime.current;
    const acknowledged = () => focus.current.active && owner?.statusEpoch === focus.current.epoch && owner?.connection === "connected" && browserHumanInputAllowed(owner.status);
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
    const acknowledged = () => focus.current.active && owner?.statusEpoch === focus.current.epoch && owner?.connection === "connected" && browserAutomationActionAllowed(owner.status, action);
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
  const currentState = state.scope === scope ? state : empty(scope, active);
  const status = currentState.status && lifetime.current?.statusEpoch !== focus.current.epoch
    ? { ...currentState.status, humanControlAvailable: false } : currentState.status;
  return { state: { ...currentState, status, ...(!active ? { connection: "inactive" as const } : {}) }, iframe,
    viewerKey: `${scope}:${viewerRevision}`, reconnect: () => { if (active) setRevision(value => value + 1); }, control, automationControl };
}
