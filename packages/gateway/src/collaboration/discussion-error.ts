export class CollaborationDiscussionError extends Error {
  constructor(
    public readonly code: "invalid_request",
    message: string,
  ) {
    super(message);
    this.name = "CollaborationDiscussionError";
  }
}
