/** Shared authorization error so the organization precondition and the authority evaluator agree on codes. */
export type CollaborationAuthorizationErrorCode = "not_found" | "forbidden" | "unavailable";

export class CollaborationAuthorizationError extends Error {
  constructor(
    public readonly code: CollaborationAuthorizationErrorCode,
    message: string,
    /** ENG-579: a `forbidden` write to an app shared read-only; routes expose it as `read_only`. */
    public readonly reason?: "read_only",
  ) {
    super(message);
    this.name = "CollaborationAuthorizationError";
  }
}
