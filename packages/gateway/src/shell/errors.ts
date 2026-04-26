export interface ShellSafeError extends Error {
  code: string;
  safeMessage: string;
  status?: number;
}

export function shellError(
  code: string,
  safeMessage = "Request failed",
  status = 500,
): ShellSafeError {
  return Object.assign(new Error(safeMessage), { code, safeMessage, status });
}

export function toShellError(err: unknown, code = "shell_failed"): ShellSafeError {
  if (err instanceof Error && "code" in err && "safeMessage" in err) {
    return err as ShellSafeError;
  }
  return shellError(code);
}
