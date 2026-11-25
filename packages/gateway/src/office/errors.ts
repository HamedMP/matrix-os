import type { OfficeDocumentErrorCode } from "@matrix-os/contracts/office-documents";
import { ProjectWriteRefusedError } from "../app-files/project-write-fence.js";
import { OwnerFileMutationBusyError } from "../owner-file-mutations.js";
import { OfficeDocumentError, errnoCode, officeEngineCodeName, officeEngineErrorCode } from "./document-error.js";
import { KeyedMutexBusyError } from "./path-mutex.js";

export { OfficeDocumentError, errnoCode } from "./document-error.js";

export function officeErrorCodeFor(error: unknown): OfficeDocumentErrorCode {
  if (error instanceof OfficeDocumentError) return error.code;
  if (error instanceof KeyedMutexBusyError || error instanceof OwnerFileMutationBusyError) return "busy";
  // A shared or fenced project is written through the shared project route, never this one.
  if (error instanceof ProjectWriteRefusedError) return error.refusal === "refused" ? "forbidden" : "unavailable";
  const engine = officeEngineErrorCode(error);
  if (engine) return engine;
  switch (errnoCode(error)) {
    case "ENOENT": return "not_found";
    case "EACCES":
    case "EPERM":
    case "ELOOP": return "forbidden";
    case "EISDIR":
    case "ENOTDIR": return "invalid_request";
    case "EFBIG": return "too_large";
    default: return "internal";
  }
}

/** Logs the failure without document text or the home path. */
export function logOfficeFailure(route: string, code: OfficeDocumentErrorCode, error: unknown): void {
  if (error instanceof ProjectWriteRefusedError) {
    console.warn("[office-documents] project write not admitted", { route, refusal: error.refusal, reason: error.reason });
    return;
  }
  // A failure on the engine thread arrives re-thrown; its origin names what it was there.
  const origin = error instanceof OfficeDocumentError ? error.origin : null;
  const detail = {
    route,
    code,
    name: origin?.name ?? (error instanceof Error ? error.name : typeof error),
    engineCode: origin?.engineCode ?? officeEngineCodeName(error),
    errno: errnoCode(error),
  };
  if (code === "internal" || code === "unavailable") {
    console.error("[office-documents] request failed", detail, error instanceof Error ? error.message : "");
  } else {
    console.warn("[office-documents] request refused", detail);
  }
}
