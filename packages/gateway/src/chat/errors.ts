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

export class ChatBusyError extends Error {
  constructor(readonly chatId: string) {
    super("Chat is busy");
    this.name = "ChatBusyError";
  }
}

export class ChatBulkArchiveLimitError extends Error {
  constructor() {
    super("Project archive exceeds the bounded Undo response");
    this.name = "ChatBulkArchiveLimitError";
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
