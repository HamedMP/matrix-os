import {
  OsViewStateResponseSchema,
  createDefaultOsViewDocument,
  mergeOsViewStatePatch,
  rebaseOsViewStatePatch,
  type OsViewStatePatch,
  type OsViewStateResponse,
} from "@matrix-os/contracts";
import { AppError } from "../../../shared/app-error";
import type { ApiClient } from "./api";

let cached: { api: ApiClient; state: OsViewStateResponse } | null = null;
let mutationQueue: Promise<void> = Promise.resolve();

function mutationId(): string {
  return `osvm_${crypto.randomUUID().replaceAll("-", "")}`;
}

export async function loadNativeOsViewState(api: ApiClient): Promise<OsViewStateResponse> {
  const state = OsViewStateResponseSchema.parse(await api.get("/api/os-view-state"));
  cached = { api, state };
  return state;
}

export function primeNativeOsViewState(api: ApiClient, state: OsViewStateResponse): void {
  cached = { api, state };
}

async function sendPatch(
  api: ApiClient,
  state: OsViewStateResponse,
  patch: OsViewStatePatch,
  id: string,
): Promise<OsViewStateResponse> {
  const response = await api.patch<unknown>("/api/os-view-state", {
    baseRevision: state.revision,
    mutationId: id,
    patch,
  });
  const parsed = OsViewStateResponseSchema.safeParse(response);
  return parsed.success ? parsed.data : {
    revision: state.revision + 1,
    document: mergeOsViewStatePatch(state.document, patch),
    updatedAt: new Date().toISOString(),
  };
}

export function patchNativeOsViewState(api: ApiClient, patch: OsViewStatePatch): Promise<void> {
  const id = mutationId();
  const write = async () => {
    let base = cached?.api === api ? cached.state : {
      revision: 1,
      document: createDefaultOsViewDocument(),
      updatedAt: new Date(0).toISOString(),
    };
    try {
      cached = { api, state: await sendPatch(api, base, patch, id) };
      return;
    } catch (error: unknown) {
      if (!(error instanceof AppError && error.detail === "os_view_state_conflict")) throw error;
    }
    const conflictedBase = base;
    base = await loadNativeOsViewState(api);
    const rebasedPatch = rebaseOsViewStatePatch(
      conflictedBase.document,
      base.document,
      patch,
    );
    cached = { api, state: await sendPatch(api, base, rebasedPatch, id) };
  };
  const pending = mutationQueue.then(write, write);
  mutationQueue = pending.catch((error: unknown) => {
    console.warn("[os-view-state] mutation queue recovered:", error instanceof Error ? error.name : "UnknownError");
  });
  return pending;
}

export function resetNativeOsViewStateClientForTests(): void {
  cached = null;
  mutationQueue = Promise.resolve();
}
