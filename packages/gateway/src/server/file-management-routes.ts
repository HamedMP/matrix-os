import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod/v4";
import {
  BatchMoveRequestSchema,
  BatchTrashRequestSchema,
  CreateFileRequestSchema,
  RenameFileRequestSchema,
} from "../file-management/contracts.js";
import {
  FileBatchMoveService,
  FileBatchMoveUnavailableError,
  FileBatchStalePreflightError,
  FileBatchTrashInvalidRequestError,
  FileBatchTrashService,
  FileBatchTrashUnavailableError,
} from "../file-management/batch-service.js";
import {
  FileBatchPreflightError,
  FileBatchPreflightUnavailableError,
} from "../file-management/preflight.js";
import {
  FileOperationCacheCapacityError,
  FileOperationRequestIdConflictError,
} from "../file-management/result-cache.js";
import {
  createFile as createTypedFile,
  fileRename as renameLegacyFile,
  renameFile as renameTypedFile,
  type FileManagementMutationResult,
} from "../file-ops.js";
import {
  isRequestPrincipalError,
  mapRequestPrincipalError,
} from "../request-principal.js";

const FILE_MANAGEMENT_BODY_LIMIT_BYTES = 128 * 1024;
const LegacyRenameRequestSchema = z.object({
  from: z.string().min(1).max(4_096),
  to: z.string().min(1).max(4_096),
}).strict();
const RenameRouteRequestSchema = z.union([
  RenameFileRequestSchema,
  LegacyRenameRequestSchema,
]);

export interface FileManagementRouteDeps {
  homePath: string;
  getOwnerId(c: Context): string;
  createFile?: typeof createTypedFile;
  renameFile?: typeof renameTypedFile;
  legacyRenameFile?: typeof renameLegacyFile;
  moveService?: FileBatchMoveRouteService;
  trashService?: FileBatchTrashRouteService;
  createMoveService?: () => FileBatchMoveRouteService;
  createTrashService?: () => FileBatchTrashRouteService;
}

export type FileBatchMoveRouteService = Pick<FileBatchMoveService, "preflight" | "execute" | "close">;
export type FileBatchTrashRouteService = Pick<
  FileBatchTrashService,
  "trash" | "delete" | "list" | "restore" | "empty" | "close"
>;

export interface FileManagementRouteRegistry {
  readonly trashService: FileBatchTrashRouteService;
  close(): Promise<void>;
}

export function registerFileManagementRoutes(
  app: Hono,
  deps: FileManagementRouteDeps,
): FileManagementRouteRegistry {
  const mutationBodyLimit = bodyLimit({ maxSize: FILE_MANAGEMENT_BODY_LIMIT_BYTES });
  const createFile = deps.createFile ?? createTypedFile;
  const renameFile = deps.renameFile ?? renameTypedFile;
  const legacyRenameFile = deps.legacyRenameFile ?? renameLegacyFile;
  const moveService = deps.moveService ?? deps.createMoveService?.() ?? new FileBatchMoveService();
  const ownsMoveService = deps.moveService === undefined;
  const trashService = deps.trashService ?? deps.createTrashService?.() ?? new FileBatchTrashService();
  const ownsTrashService = deps.trashService === undefined;
  let closePromise: Promise<void> | undefined;

  app.post("/api/files/create", mutationBodyLimit, async (c) => {
    const body = await parseJson(c);
    const parsed = CreateFileRequestSchema.safeParse(body);
    if (!parsed.success) return badRequest(c);

    try {
      requireOwnerId(deps.getOwnerId(c));
      const result = await createFile(deps.homePath, parsed.data);
      return mutationResponse(c, result);
    } catch (error: unknown) {
      if (isRequestPrincipalError(error)) {
        const mapped = mapRequestPrincipalError(error, "File operation failed");
        if (mapped.log) {
          console.error(`[file-management] Owner resolution failed for request ${parsed.data.requestId}:`, safeLogError(error));
        }
        return c.json(mapped.body, mapped.status);
      }
      console.error(`[file-management] Create failed for request ${parsed.data.requestId}:`, safeLogError(error));
      return c.json({ error: "File operation failed", code: "failed" }, 500);
    }
  });

  app.post("/api/files/rename", mutationBodyLimit, async (c) => {
    const body = await parseJson(c);
    const parsed = RenameRouteRequestSchema.safeParse(body);
    if (!parsed.success) return badRequest(c);
    const requestId = "requestId" in parsed.data ? parsed.data.requestId : "legacy";

    try {
      requireOwnerId(deps.getOwnerId(c));
      if ("requestId" in parsed.data) {
        return mutationResponse(c, await renameFile(deps.homePath, parsed.data));
      }
      const result = await legacyRenameFile(deps.homePath, parsed.data.from, parsed.data.to);
      return c.json(result, {
        status: toStatusCode(result.ok ? 200 : (result.status ?? 400)),
      });
    } catch (error: unknown) {
      return routeError(c, error, "Rename", requestId);
    }
  });

  app.post("/api/files/batch/move", mutationBodyLimit, async (c) => {
    const body = await parseJson(c);
    const parsed = BatchMoveRequestSchema.safeParse(body);
    if (!parsed.success) return badRequest(c);

    try {
      const ownerId = requireOwnerId(deps.getOwnerId(c));
      const result = parsed.data.phase === "preflight"
        ? await moveService.preflight({
            ownerId,
            homePath: deps.homePath,
            requestId: parsed.data.requestId,
            sources: parsed.data.sources,
            destinationDirectory: parsed.data.destinationDirectory,
          })
        : await moveService.execute({
            ownerId,
            homePath: deps.homePath,
            requestId: parsed.data.requestId,
            preflightFingerprint: parsed.data.preflightFingerprint,
            ...(parsed.data.conflictChoices ? { conflictChoices: parsed.data.conflictChoices } : {}),
          });
      return c.json(result, 200);
    } catch (error: unknown) {
      return routeError(c, error, "Batch move", parsed.data.requestId);
    }
  });

  app.post("/api/files/batch/trash", mutationBodyLimit, async (c) => {
    const body = await parseJson(c);
    const parsed = BatchTrashRequestSchema.safeParse(body);
    if (!parsed.success) return badRequest(c);

    try {
      const ownerId = requireOwnerId(deps.getOwnerId(c));
      const result = await trashService.trash({
        ownerId,
        homePath: deps.homePath,
        requestId: parsed.data.requestId,
        sources: parsed.data.sources,
      });
      return c.json(result, 200);
    } catch (error: unknown) {
      return routeError(c, error, "Batch Trash", parsed.data.requestId);
    }
  });

  return {
    trashService,
    close() {
      closePromise ??= Promise.resolve().then(async () => {
        if (ownsTrashService) await trashService.close();
        if (ownsMoveService) await moveService.close();
      });
      return closePromise;
    },
  };
}

async function parseJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json<unknown>();
  } catch (error: unknown) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

function requireOwnerId(ownerId: string): string {
  if (!ownerId) throw new Error("Missing request owner");
  return ownerId;
}

function badRequest(c: Context) {
  return c.json({ error: "Invalid request", code: "invalid_request" }, 400);
}

function mutationResponse(c: Context, result: FileManagementMutationResult) {
  if (result.ok) return c.json(result, 200);
  const statusByCode: Record<NonNullable<FileManagementMutationResult["errorCode"]>, ContentfulStatusCode> = {
    invalid_path: 400,
    protected: 403,
    destination_conflict: 409,
    source_missing: 404,
    cleanup_failed: 500,
    failed: 500,
  };
  const code = result.errorCode ?? "failed";
  return c.json({ ok: false, errorCode: code }, { status: statusByCode[code] });
}

function routeError(c: Context, error: unknown, operation: string, requestId: string) {
  if (isRequestPrincipalError(error)) {
    const mapped = mapRequestPrincipalError(error, "File operation failed");
    if (mapped.log) {
      console.error(`[file-management] Owner resolution failed for request ${requestId}:`, safeLogError(error));
    }
    return c.json(mapped.body, mapped.status);
  }
  if (error instanceof FileOperationRequestIdConflictError) {
    return c.json({ error: "Request identifier conflict", code: "request_id_conflict" }, 409);
  }
  if (error instanceof FileBatchStalePreflightError) {
    return c.json({ error: "File operation conflict", code: "invalid_destination" }, 409);
  }
  if (error instanceof FileBatchPreflightError) {
    return c.json({ error: "Invalid request", code: "invalid_destination" }, 400);
  }
  if (
    error instanceof FileOperationCacheCapacityError
    || error instanceof FileBatchMoveUnavailableError
    || error instanceof FileBatchTrashUnavailableError
  ) {
    console.error(`[file-management] ${operation} unavailable for request ${requestId}:`, safeLogError(error));
    return c.json({ error: "File operation unavailable", code: "operation_unavailable" }, 503);
  }
  if (error instanceof FileBatchPreflightUnavailableError) {
    console.error(`[file-management] ${operation} failed for request ${requestId}:`, safeLogError(error));
    return c.json({ error: "File operation failed", code: "failed" }, 500);
  }
  if (error instanceof FileBatchTrashInvalidRequestError) {
    return c.json({ error: "Invalid request", code: "invalid_destination" }, 400);
  }
  console.error(`[file-management] ${operation} failed for request ${requestId}:`, safeLogError(error));
  return c.json({ error: "File operation failed", code: "failed" }, 500);
}

function toStatusCode(status: number): ContentfulStatusCode {
  return status as ContentfulStatusCode;
}

function safeLogError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
