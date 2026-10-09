/** Local diagnostics contain fixed classes only, never error text or file/input data. */
export function toolFailureDiagnostic(cause) {
  try {
    if (cause instanceof TypeError) return { error_type: "type" };
    if (cause instanceof SyntaxError) return { error_type: "syntax" };
    if (cause instanceof RangeError) return { error_type: "range" };
    if (cause instanceof Error) {
      // Inspect data properties only: thrown objects may have hostile accessors.
      const name = Object.getOwnPropertyDescriptor(cause, "name");
      return { error_type: name?.value === "AbortError" ? "aborted" : "error" };
    }
  } catch (inspectionFailure) {
    // Revoked proxies and reflection traps cannot be inspected safely.
    return { error_type: "unknown" };
  }
  return { error_type: "unknown" };
}

export function reportToolFailure(cause) {
  const diagnostic = toolFailureDiagnostic(cause);
  try { console.warn("Utility operation failed.", diagnostic); }
  catch (loggingFailure) { return toolFailureDiagnostic(loggingFailure); }
  return diagnostic;
}
