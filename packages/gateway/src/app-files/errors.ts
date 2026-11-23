import type { AppFileErrorCode } from "@matrix-os/contracts/app-files";
import { OwnerFileMutationBusyError } from "../owner-file-mutations.js";
import { ProjectWriteRefusedError } from "./project-write-fence.js";

/** A failure with a client-safe code. The cause stays server-side. */
export class AppFileError extends Error {
  readonly code: AppFileErrorCode;
  constructor(code: AppFileErrorCode, readonly reason?: string) {
    super(`App file request failed: ${code}`);
    this.name = "AppFileError";
    this.code = code;
  }
}

const ERRNO_CODES: Readonly<Record<string, AppFileErrorCode>> = Object.freeze({
  ENOENT: "not_found",
  ENOTDIR: "not_found",
  EACCES: "forbidden",
  EPERM: "forbidden",
  ELOOP: "forbidden",
  EISDIR: "invalid_request",
  EFBIG: "too_large",
});

export function errnoCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === "string" ? code : undefined;
}

/** Map any thrown value to a client-safe code. Anything unexpected is `unavailable`. */
export function appFileErrorCodeFor(error: unknown): AppFileErrorCode {
  if (error instanceof AppFileError) return error.code;
  if (error instanceof OwnerFileMutationBusyError) return "unavailable";
  // A shared or fenced project is written through the shared project route, never this one.
  if (error instanceof ProjectWriteRefusedError) return error.refusal === "refused" ? "forbidden" : "unavailable";
  const errno = errnoCode(error);
  return (errno && ERRNO_CODES[errno]) || "unavailable";
}

/** Log detail without leaking it to the client. Paths are not logged. */
export function logAppFileFailure(kind: string, error: unknown): void {
  if (error instanceof AppFileError) {
    if (error.reason) console.warn("[app-files] request refused", { kind, code: error.code, reason: error.reason });
    return;
  }
  if (error instanceof ProjectWriteRefusedError) {
    console.warn("[app-files] project write not admitted", { kind, refusal: error.refusal, reason: error.reason });
    return;
  }
  console.warn("[app-files] request failed", {
    kind,
    name: error instanceof Error ? error.name : "UnknownError",
    errno: errnoCode(error),
  });
}
