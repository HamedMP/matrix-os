import { randomUUID } from "node:crypto";
import {
  MemoryImportInventorySchema,
  MemoryImportBatchSchema,
  type MemoryImportProvider,
  type MemoryImportPreviewRequest,
  type MemoryImportBatch,
} from "../../shared/memory-import-ipc";
import { parseMemoryExport } from "./export-parser";
interface Dependencies {
  native: (
    provider: MemoryImportProvider,
    action: "inventory" | "preview",
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<unknown>;
  chooseFile: () => Promise<string | null>;
  readFile: (path: string) => Promise<{
    name: string;
    content: string;
    sourceIdentity?: string;
  }>;
  platform?: string;
  now?: () => number;
  identity?: () => string | null;
}
const ERRORS = {
  unsupported:
    "Native imports are available in the macOS desktop app. You can import an export file instead.",
  permission_denied:
    "Allow Matrix OS to access this app in System Settings → Privacy & Security → Automation, then try again.",
  unavailable:
    "This source could not be read. Try again or import an export file.",
  selection_required:
    "Select available folders, mailboxes or calendars before previewing.",
  expired: "This preview expired. Preview your selection again.",
  invalid_export:
    "This export could not be read. Choose a supported text, calendar or JSON export.",
  timeout:
    "Reading this source took too long. Choose a smaller collection or import an export file.",
} as const;
type Code = keyof typeof ERRORS;
const failure = (code: Code) => ({
  status: "error" as const,
  code,
  message: ERRORS[code],
});
/** Local previews never upload. An exact, single-use confirmation hands approved records to the renderer. */
export function createMemoryImportService(deps: Dependencies) {
  const now = deps.now ?? Date.now;
  const identity = deps.identity ?? (() => "local");
  let generation = 0;
  let disposed = false;
  let nativeBusy = false;
  let fileBusy = false;
  let nativeOperation: AbortController | null = null;
  const inventories = new Map<
    MemoryImportProvider,
    {
      expires: number;
      ids: string[];
      identity: string;
    }
  >(); // Three providers maximum, TTL expiry.
  const selections = new Map<
    string,
    {
      expires: number;
      batch: MemoryImportBatch;
      identity: string;
    }
  >(); // Eight previews maximum, oldest-first eviction.
  const sweep = () => {
    for (const [id, p] of selections)
      if (p.expires <= now()) selections.delete(id);
    for (const [id, p] of inventories)
      if (p.expires <= now()) inventories.delete(id);
  };
  const cache = (batch: MemoryImportBatch, boundIdentity: string) => {
    sweep();
    while (selections.size >= 8)
      selections.delete(selections.keys().next().value!);
    const selectionId = randomUUID();
    selections.set(selectionId, {
      expires: now() + 600000,
      batch,
      identity: boundIdentity,
    });
    return { status: "preview" as const, selectionId, ...batch };
  };
  const error = (e: unknown) => {
    const code =
      e instanceof Error
        ? (
            e as Error & {
              code?: string;
            }
          ).code
        : undefined;
    console.warn("[memory-import] source read failed", code ?? "unknown");
    return failure(
      code === "permission_denied"
        ? "permission_denied"
        : code === "timeout"
          ? "timeout"
          : "unavailable",
    );
  };
  const timer = setInterval(sweep, 60000);
  timer.unref?.();
  return {
    async inventory({ provider }: { provider: MemoryImportProvider }) {
      if (disposed || !identity()) return failure("unavailable");
      if ((deps.platform ?? process.platform) !== "darwin")
        return failure("unsupported");
      if (nativeBusy) return failure("unavailable");
      nativeBusy = true;
      nativeOperation = new AbortController();
      const epoch = generation,
        boundIdentity = identity()!;
      try {
        const value = MemoryImportInventorySchema.parse(
          await deps.native(provider, "inventory", {}, nativeOperation.signal),
        );
        if (epoch !== generation || identity() !== boundIdentity)
          return failure("expired");
        inventories.set(provider, {
          expires: now() + 600000,
          ids: value.collections.map((x) => x.id),
          identity: boundIdentity,
        });
        return { status: "ready" as const, ...value };
      } catch (e) {
        return error(e);
      } finally {
        nativeBusy = false;
        nativeOperation = null;
      }
    },
    async preview(input: MemoryImportPreviewRequest) {
      sweep();
      const inventory = inventories.get(input.provider);
      if (
        disposed ||
        !inventory ||
        inventory.identity !== identity() ||
        input.collectionIds.some((id) => !inventory.ids.includes(id))
      )
        return failure("selection_required");
      if (nativeBusy) return failure("unavailable");
      nativeBusy = true;
      nativeOperation = new AbortController();
      const epoch = generation,
        boundIdentity = identity()!;
      try {
        const value = MemoryImportBatchSchema.parse(
          await deps.native(
            input.provider,
            "preview",
            { ...input },
            nativeOperation.signal,
          ),
        );
        if (value.records.length > input.limit) return failure("unavailable");
        if (epoch !== generation || identity() !== boundIdentity)
          return failure("expired");
        return cache(value, boundIdentity);
      } catch (e) {
        return error(e);
      } finally {
        nativeBusy = false;
        nativeOperation = null;
      }
    },
    async file() {
      if (disposed || fileBusy || !identity()) return failure("unavailable");
      fileBusy = true;
      const epoch = generation,
        boundIdentity = identity()!;
      try {
        const path = await deps.chooseFile();
        if (!path) return { status: "cancelled" as const };
        const value = await deps.readFile(path);
        if (epoch !== generation || identity() !== boundIdentity)
          return failure("expired");
        return cache(
          parseMemoryExport(value.name, value.content, value.sourceIdentity),
          boundIdentity,
        );
      } catch (e) {
        console.warn(
          "[memory-import] export read failed",
          e instanceof Error ? e.name : "unknown",
        );
        return failure("invalid_export");
      } finally {
        fileBusy = false;
      }
    },
    async confirm({
      selectionId,
      externalIds,
    }: {
      selectionId: string;
      externalIds?: string[];
    }) {
      sweep();
      const value = selections.get(selectionId);
      if (!value || disposed || identity() !== value.identity)
        return failure("expired");
      if (
        externalIds?.some(
          (id) => !value.batch.records.some((r) => r.externalId === id),
        )
      )
        return failure("selection_required");
      selections.delete(selectionId);
      return {
        status: "confirmed" as const,
        records: externalIds
          ? value.batch.records.filter((r) =>
              externalIds.includes(r.externalId),
            )
          : value.batch.records,
        warnings: value.batch.warnings,
      };
    },
    cancelAll() {
      generation++;
      nativeOperation?.abort();
      inventories.clear();
      selections.clear();
      return { ok: true };
    },
    dispose() {
      disposed = true;
      generation++;
      nativeOperation?.abort();
      clearInterval(timer);
      inventories.clear();
      selections.clear();
    },
  };
}
