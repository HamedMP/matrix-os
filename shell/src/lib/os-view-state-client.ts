import {
  OsViewStateResponseSchema,
  createDefaultOsViewDocument,
  mergeOsViewStatePatch,
  rebaseOsViewStatePatch,
  type OsViewStatePatch,
  type OsViewStateResponse,
  type OsViewMode,
} from "@matrix-os/contracts";
import type { LayoutWindow } from "@/hooks/useWindowManager";

const REQUEST_TIMEOUT_MS = 10_000;

let cached: { gatewayUrl: string; state: OsViewStateResponse } | null = null;
let mutationQueue: Promise<void> = Promise.resolve();

function mutationId(): string {
  return `osvm_${crypto.randomUUID().replaceAll("-", "")}`;
}

async function requestState(gatewayUrl: string, signal?: AbortSignal): Promise<OsViewStateResponse> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const response = await fetch(`${gatewayUrl}/api/os-view-state`, {
    cache: "no-store",
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!response.ok) throw new Error(`GET /api/os-view-state ${response.status}`);
  return OsViewStateResponseSchema.parse(await response.json());
}

export async function loadWebOsViewState(
  gatewayUrl: string,
  signal?: AbortSignal,
): Promise<OsViewStateResponse> {
  const state = await requestState(gatewayUrl, signal);
  cached = { gatewayUrl, state };
  return state;
}

async function sendPatch(
  gatewayUrl: string,
  state: OsViewStateResponse,
  patch: OsViewStatePatch,
  id: string,
): Promise<{ conflict: boolean; state?: OsViewStateResponse }> {
  const response = await fetch(`${gatewayUrl}/api/os-view-state`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    body: JSON.stringify({ baseRevision: state.revision, mutationId: id, patch }),
  });
  if (response.status === 409) return { conflict: true };
  if (!response.ok) throw new Error(`PATCH /api/os-view-state ${response.status}`);
  const parsed = typeof response.json === "function"
    ? OsViewStateResponseSchema.safeParse(await response.json())
    : null;
  return {
    conflict: false,
    state: parsed?.success ? parsed.data : {
      revision: state.revision + 1,
      document: mergeOsViewStatePatch(state.document, patch),
      updatedAt: new Date().toISOString(),
    },
  };
}

export function patchWebOsViewState(
  gatewayUrl: string,
  patch: OsViewStatePatch,
): Promise<void> {
  const id = mutationId();
  const write = async () => {
    let base = cached?.gatewayUrl === gatewayUrl ? cached.state : {
      revision: 1,
      document: createDefaultOsViewDocument(),
      updatedAt: new Date(0).toISOString(),
    };
    let result = await sendPatch(gatewayUrl, base, patch, id);
    if (result.conflict) {
      const conflictedBase = base;
      base = await requestState(gatewayUrl);
      const rebasedPatch = rebaseOsViewStatePatch(
        conflictedBase.document,
        base.document,
        patch,
      );
      result = await sendPatch(gatewayUrl, base, rebasedPatch, id);
    }
    if (!result.state) throw new Error("OS-view state remained conflicted");
    cached = { gatewayUrl, state: result.state };
  };
  const pending = mutationQueue.then(write, write);
  mutationQueue = pending.catch((error: unknown) => {
    console.warn("[os-view-state] mutation queue recovered:", error instanceof Error ? error.name : "UnknownError");
  });
  return pending;
}

export function resetWebOsViewStateClientForTests(): void {
  cached = null;
  mutationQueue = Promise.resolve();
}

export function layoutWindowsFromOsViewState(
  state: OsViewStateResponse,
  mode: OsViewMode,
): LayoutWindow[] {
  const selectedGeometry = mode === "canvas"
    ? state.document.canvas.windows
    : state.document.desktop.windows;
  const counterpartGeometry = mode === "canvas"
    ? state.document.desktop.windows
    : state.document.canvas.windows;
  const selectedByPath = new Map(selectedGeometry.map((window) => [window.path, window]));
  const counterpartByPath = new Map(counterpartGeometry.map((window) => [window.path, window]));
  return state.document.apps.flatMap((app) => {
    // App state is shared, while geometry is presentation-specific. A newly
    // selected presentation may not have written geometry yet, so seed it from
    // the other presentation instead of hiding an app that is durably open.
    const bounds = selectedByPath.get(app.path) ?? counterpartByPath.get(app.path);
    if (!bounds) return [];
    return [{ ...bounds, title: app.title, state: app.state }];
  });
}

export async function loadWebOsViewPresentation(
  gatewayUrl: string,
  mode: OsViewMode,
  signal?: AbortSignal,
): Promise<{
  windows: LayoutWindow[];
  transform: OsViewStateResponse["document"]["canvas"]["transform"];
} | null> {
  try {
    const state = await loadWebOsViewState(gatewayUrl, signal);
    if (state.document.apps.length === 0) return null;
    return {
      windows: layoutWindowsFromOsViewState(state, mode),
      transform: state.document.canvas.transform,
    };
  } catch (error: unknown) {
    if (!signal?.aborted) {
      console.warn("[os-view-state] Web layout load failed:", error instanceof Error ? error.name : "UnknownError");
    }
    return null;
  }
}
