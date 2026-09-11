import {
  CollaborationScopeSchema,
  CollaborationTerminalActionResultSchema,
  CollaborationTerminalFrameSchema,
  CollaborationTerminalSchema,
  type CollaborationTerminal,
} from "@matrix-os/contracts";
import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import type { z } from "zod/v4";
import type { CollaborationApi } from "./ChatCollaboratorsDialog.js";

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const LEASE_RENEW_INTERVAL_MS = 10_000;
const buttonClass = "rounded-lg border px-3 py-2 text-sm transition-colors hover:enabled:bg-[var(--bg-hover)] disabled:opacity-50";

type Scope = z.infer<typeof CollaborationScopeSchema>;
type State = {
  terminal: CollaborationTerminal | null;
  connectionId: string | null;
  output: string;
  loading: boolean;
  pending: boolean;
  unavailable: boolean;
  error: boolean;
};

type Action =
  | { type: "ready"; terminal: CollaborationTerminal; connectionId: string }
  | { type: "state"; terminal: CollaborationTerminal }
  | { type: "output"; data: string }
  | { type: "refresh"; terminal: CollaborationTerminal }
  | { type: "pending"; value: boolean }
  | { type: "error" }
  | { type: "unavailable" };

const initialState: State = {
  terminal: null,
  connectionId: null,
  output: "",
  loading: true,
  pending: false,
  unavailable: false,
  error: false,
};

export function SharedTerminalControls({ api, scope, actorId }: {
  api: CollaborationApi;
  scope: Scope;
  actorId: string;
}) {
  const [state, dispatch] = useReducer(reduce, initialState);
  const [input, setInput] = useState("");
  const refresh = useCallback(async () => {
    const terminal = CollaborationTerminalSchema.parse(await api.get(
      `/api/collaboration/scopes/${scope.id}/terminal`,
    ));
    dispatch({ type: "refresh", terminal });
  }, [api, scope.id]);

  useEffect(() => {
    let active = true;
    void refresh().catch((error: unknown) => {
      console.warn("[terminal-collaboration] terminal load failed", error instanceof Error ? error.name : "UnknownError");
      if (active) dispatch({ type: "error" });
    });
    if (!api.subscribeTerminal) {
      dispatch({ type: "unavailable" });
      return () => { active = false; };
    }
    const unsubscribe = api.subscribeTerminal(scope.id, {
      onReady: (value) => {
        if (!active) return;
        const frame = CollaborationTerminalFrameSchema.parse(value);
        if (frame.type === "terminal.ready") {
          dispatch({ type: "ready", terminal: frame.terminal, connectionId: frame.connectionId });
        }
      },
      onOutput: (value) => {
        if (!active) return;
        const frame = CollaborationTerminalFrameSchema.parse(value);
        if (frame.type === "terminal.output") dispatch({ type: "output", data: frame.data });
      },
      onState: (value) => {
        if (!active) return;
        const frame = CollaborationTerminalFrameSchema.parse(value);
        if (frame.type === "terminal.state") dispatch({ type: "state", terminal: frame.terminal });
      },
      onRefreshRequired: refresh,
      onUnavailable: () => { if (active) dispatch({ type: "unavailable" }); },
    });
    return () => { active = false; unsubscribe(); };
  }, [api, refresh, scope.id]);

  const controller = state.terminal?.controller;
  const holdsControl = controller?.actor.actorId === actorId;
  const canControl = scope.capabilities.controlTerminal && scope.role !== "viewer"
    && state.terminal?.status === "active" && !state.unavailable;
  const canStop = state.terminal?.status === "active" && !state.unavailable
    && (scope.capabilities.stopTerminal
      || (scope.role === "editor" && state.terminal.createdBy.actorId === actorId));
  const sendAction = useCallback(async (action: Record<string, unknown>) => {
    if (!state.terminal || !state.connectionId) return;
    dispatch({ type: "pending", value: true });
    try {
      const result = CollaborationTerminalActionResultSchema.parse(await api.post(
        `/api/collaboration/scopes/${scope.id}/terminal/actions`,
        {
          ...action,
          clientRequestId: crypto.randomUUID(),
          incarnation: state.terminal.incarnation,
          ...(action.type === "stop" ? {} : { connectionId: state.connectionId }),
        },
      ));
      dispatch({ type: "state", terminal: result.terminal });
      dispatch({ type: "pending", value: false });
    } catch (error: unknown) {
      console.warn("[terminal-collaboration] action failed", error instanceof Error ? error.name : "UnknownError");
      dispatch({ type: "error" });
    }
  }, [api, scope.id, state.connectionId, state.terminal]);

  useEffect(() => {
    if (!holdsControl || !controller || !canControl) return;
    const timer = setInterval(() => {
      void sendAction({ type: "renew", leaseEpoch: controller.leaseEpoch });
    }, LEASE_RENEW_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [canControl, controller, holdsControl, sendAction]);

  const controlLabel = useMemo(() => {
    if (scope.role === "viewer") return "Watching only";
    if (holdsControl) return "You have control";
    if (controller) return `${controller.actor.displayName} has control`;
    return "No one has control";
  }, [controller, holdsControl, scope.role]);

  const submitText = (type: "input" | "paste") => {
    if (!holdsControl || !controller || !input) return;
    void sendAction({ type, leaseEpoch: controller.leaseEpoch, data: input });
    setInput("");
  };

  return <section className="flex min-h-0 flex-1 flex-col bg-[#101218] text-[#e4e4e7]">
    <header className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
      <div>
        <p className="text-xs uppercase tracking-[0.16em] text-zinc-400">Shared terminal</p>
        <p className="mt-0.5 text-sm font-medium">{controlLabel}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        {canControl && !holdsControl && !controller ? <button type="button" className={buttonClass}
          disabled={state.pending || !state.connectionId} onClick={() => void sendAction({ type: "acquire" })}>
          Request control
        </button> : null}
        {canControl && !holdsControl && controller && scope.role === "owner" ? <button type="button" className={buttonClass}
          disabled={state.pending || !state.connectionId} onClick={() => void sendAction({ type: "takeover" })}>
          Take control from {controller.actor.displayName}
        </button> : null}
        {canControl && holdsControl && controller ? <button type="button" className={buttonClass}
          disabled={state.pending} onClick={() => void sendAction({ type: "release", leaseEpoch: controller.leaseEpoch })}>
          Release control
        </button> : null}
        {canStop ? <button type="button" className={buttonClass}
          disabled={state.pending} onClick={() => void sendAction({ type: "stop" })}>Stop terminal</button> : null}
      </div>
    </header>
    {state.unavailable ? <p role="alert" className="border-b border-red-400/30 bg-red-950/30 px-4 py-3 text-sm text-red-100">
      This shared terminal is no longer available. Return to Shared with me to check your access.
    </p> : null}
    {state.error && !state.unavailable ? <p role="alert" className="border-b border-amber-400/30 bg-amber-950/30 px-4 py-3 text-sm text-amber-100">
      The terminal action could not be completed. Refresh the terminal state and try again.
    </p> : null}
    <pre aria-label="Shared terminal output" className="min-h-[16rem] flex-1 overflow-auto whitespace-pre-wrap break-all p-4 font-mono text-sm"
      role="log">{state.output || (state.loading ? "Connecting to shared terminal…" : "No retained output.")}</pre>
    <div className="grid gap-2 border-t border-white/10 p-3 sm:grid-cols-[1fr_auto_auto]">
      <label className="sr-only" htmlFor={`shared-terminal-input-${scope.id}`}>Terminal input</label>
      <textarea id={`shared-terminal-input-${scope.id}`} aria-label="Terminal input" rows={2} value={input}
        disabled={!holdsControl || state.pending || state.unavailable}
        onChange={(event) => setInput(event.target.value)}
        placeholder={holdsControl ? "Type terminal input" : "Take control to send input"}
        className="min-w-0 resize-none rounded-lg border border-white/15 bg-black/20 px-3 py-2 font-mono text-sm" />
      <button type="button" className={buttonClass} disabled={!holdsControl || !input || state.pending}
        onClick={() => submitText("input")}>Send input</button>
      <button type="button" className={buttonClass} disabled={!holdsControl || !input || state.pending}
        onClick={() => submitText("paste")}>Paste text</button>
    </div>
  </section>;
}

function reduce(state: State, action: Action): State {
  if (action.type === "ready") return { ...state, terminal: action.terminal, connectionId: action.connectionId,
    loading: false, unavailable: false, error: false };
  if (action.type === "state") return { ...state, terminal: action.terminal, pending: false, error: false };
  if (action.type === "refresh") return { ...state, terminal: action.terminal, loading: false, error: false };
  if (action.type === "output") return { ...state, output: appendBounded(state.output, action.data) };
  if (action.type === "pending") return { ...state, pending: action.value, error: false };
  if (action.type === "error") return { ...state, loading: false, pending: false, error: true };
  return { ...state, loading: false, pending: false, unavailable: true, connectionId: null };
}

function appendBounded(current: string, addition: string): string {
  const combined = current + addition;
  const encoded = new TextEncoder().encode(combined);
  if (encoded.byteLength <= MAX_OUTPUT_BYTES) return combined;
  return new TextDecoder().decode(encoded.slice(encoded.byteLength - MAX_OUTPUT_BYTES));
}
