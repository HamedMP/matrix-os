/** Transport-neutral HTTP metadata only; never copies a provider/error message. */
export function safeHttpStatus(failure: unknown): number | null {
  if (typeof failure !== "object" || failure === null) return null;
  const status = "status" in failure && typeof failure.status === "number" ? failure.status
    : "httpStatus" in failure && typeof failure.httpStatus === "number" ? failure.httpStatus : null;
  return status !== null && Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
}
