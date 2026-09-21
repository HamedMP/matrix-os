/** Shared authorization error so the organization precondition and the authority evaluator agree on codes. */
export type CollaborationAuthorizationErrorCode = "not_found" | "forbidden" | "unavailable";

export class CollaborationAuthorizationError extends Error {
  constructor(
    public readonly code: CollaborationAuthorizationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CollaborationAuthorizationError";
  }
}
