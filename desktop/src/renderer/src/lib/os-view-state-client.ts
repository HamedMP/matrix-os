import {
  LegacyDesktopImportSchema,
  OsViewStateResponseSchema,
  createDefaultOsViewDocument,
  mergeOsViewStatePatch,
  legacyDesktopImportFromConfig,
  rebaseOsViewStatePatch,
  type OsViewStatePatch,
  type OsViewStateResponse,
  type LegacyDesktopImport,
} from "@matrix-os/contracts";
import { AppError } from "../../../shared/app-error";
import type { ApiClient } from "./api";
import { loadNativeDesktopConfig } from "./desktop-config-client";

let cached: { api: ApiClient; state: OsViewStateResponse } | null = null;
let mutationQueue: Promise<void> = Promise.resolve();
const MAX_CONFLICT_REBASE_ATTEMPTS = 3;

export class OsViewStateConflictExhaustedError extends Error {
  constructor() {
    super("OS-view state conflicted repeatedly");
    this.name = "OsViewStateConflictExhaustedError";
  }
}

function mutationId(): string {
  return `osvm_${crypto.randomUUID().replaceAll("-", "")}`;
}

export async function loadNativeOsViewState(api: ApiClient): Promise<OsViewStateResponse> {
  const state = OsViewStateResponseSchema.parse(await api.get("/api/os-view-state"));
  cached = { api, state };
  return state;
}

export async function importNativeLegacyDesktopConfig(
  api: ApiClient,
  input: LegacyDesktopImport,
): Promise<OsViewStateResponse> {
  const legacy = LegacyDesktopImportSchema.parse(input);
  const state = OsViewStateResponseSchema.parse(
    await api.post("/api/os-view-state/import-legacy-desktop", legacy),
  );
  cached = { api, state };
  return state;
}

export async function loadNativeOsViewStateWithLegacyImport(
  api: ApiClient,
): Promise<OsViewStateResponse> {
  if (typeof api.post !== "function") return loadNativeOsViewState(api);
  try {
    const legacy = legacyDesktopImportFromConfig(await loadNativeDesktopConfig(api));
    if (legacy !== null) return await importNativeLegacyDesktopConfig(api, legacy);
  } catch (error: unknown) {
    console.warn("[os-view-state] Electron Desktop legacy import failed:", error instanceof Error ? error.name : "UnknownError");
  }
  return loadNativeOsViewState(api);
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
    let pendingPatch = patch;
    let conflictRebaseAttempts = 0;
    while (true) {
      try {
        cached = { api, state: await sendPatch(api, base, pendingPatch, id) };
        return;
      } catch (error: unknown) {
        if (!(error instanceof AppError && error.detail === "os_view_state_conflict")) throw error;
      }
      if (conflictRebaseAttempts >= MAX_CONFLICT_REBASE_ATTEMPTS) {
        throw new OsViewStateConflictExhaustedError();
      }
      conflictRebaseAttempts += 1;
      const conflictedBase = base;
      base = await loadNativeOsViewState(api);
      pendingPatch = rebaseOsViewStatePatch(
        conflictedBase.document,
        base.document,
        pendingPatch,
      );
    }
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
