/** Failure and cleanup guards for the Electron Desktop visual evidence runner. */
export async function captureStep(
  name: string,
  run: () => Promise<void>,
  onFailure: (name: string, error: unknown) => Promise<void>,
  optional = false,
): Promise<boolean> {
  try {
    await run();
    return true;
  } catch (error: unknown) {
    try {
      await onFailure(name, error);
    } catch (reportError: unknown) {
      console.warn("[s20] failure capture failed", reportError);
    }
    if (!optional) throw error;
    return false;
  }
}

export async function cleanupWithRestore(
  cleanup: () => Promise<void>,
  restore: () => void,
): Promise<void> {
  try {
    await cleanup();
  } finally {
    restore();
  }
}

/** Retain a bounded, insertion-ordered sample for capture diagnostics. */
export function recordBoundedDiagnostic(diagnostics: Set<string>, value: string): void {
  diagnostics.delete(value);
  diagnostics.add(value);
  if (diagnostics.size > 50) diagnostics.delete(diagnostics.values().next().value!);
}
