export class ChatNotFoundError extends Error {
  constructor(readonly chatId: string) {
    super("Chat not found");
    this.name = "ChatNotFoundError";
  }
}

export class ChatConflictError extends Error {
  constructor(readonly chatId: string, readonly latestRevision: number) {
    super("Chat conflict");
    this.name = "ChatConflictError";
  }
}

/** Exact owner/request/hash lookup found a queue entry deliberately cancelled by its owner. */
export class ChatQueuedTurnCancelledError extends ChatConflictError {
  constructor(chatId: string, latestRevision: number) {
    super(chatId, latestRevision);
    this.name = "ChatQueuedTurnCancelledError";
  }
}

export class ChatBusyError extends Error {
  constructor(readonly chatId: string) {
    super("Chat is busy");
    this.name = "ChatBusyError";
  }
}

export class ChatProviderInstanceLockedError extends Error {
  constructor(readonly chatId: string) {
    super("Provider Instance is locked");
    this.name = "ChatProviderInstanceLockedError";
  }
}

export class ChatRunNotActiveError extends Error {
  constructor(readonly chatId: string, readonly runId: string) {
    super("Chat Run is not active");
    this.name = "ChatRunNotActiveError";
  }
}

export class ChatRunNotAcknowledgeableError extends Error {
  constructor(readonly chatId: string, readonly runId: string) {
    super("Chat Run is not a successful completion");
    this.name = "ChatRunNotAcknowledgeableError";
  }
}
