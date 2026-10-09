/** Local diagnostics contain fixed classes only, never error text or file/input data. */
export function reportToolFailure(cause) {
  const error_type = cause instanceof TypeError ? "type"
    : cause instanceof SyntaxError ? "syntax"
    : cause instanceof RangeError ? "range"
    : cause instanceof Error ? cause.name === "AbortError" ? "aborted" : "error"
    : "unknown";
  console.warn("Utility operation failed.", { error_type });
}
