export type ConversationRunMessage =
  | { type: "kernel:init"; sessionId: string; requestId?: string }
  | { type: "kernel:text"; text: string; requestId?: string }
  | { type: "kernel:tool_start"; tool: string; requestId?: string }
  | { type: "kernel:tool_end"; input?: Record<string, unknown>; requestId?: string }
  | { type: "kernel:result"; data: unknown; requestId?: string }
  | { type: "kernel:error"; message: string; requestId?: string }
  | { type: "kernel:aborted"; requestId?: string };

export interface ConversationRunRegistryOptions {
  maxRuns?: number;
  maxEventsPerRun?: number;
  maxSubscribersPerRun?: number;
}

type Subscriber = (message: ConversationRunMessage) => void;

interface AttachOptions {
  replayBuffered?: boolean;
}

export interface ConversationRunAttachment {
  detach: () => void;
  bufferedMessages: ConversationRunMessage[];
}

interface RunState {
  readonly sessionId: string;
  readonly createdAt: number;
  readonly messages: ConversationRunMessage[];
  readonly subscribers: Set<Subscriber>;
}

export class ConversationRunRegistry {
  private readonly runs = new Map<string, RunState>();
  private readonly maxRuns: number;
  private readonly maxEventsPerRun: number;
  private readonly maxSubscribersPerRun: number;

  constructor(options?: ConversationRunRegistryOptions) {
    this.maxRuns = options?.maxRuns ?? 50;
    this.maxEventsPerRun = options?.maxEventsPerRun ?? 5_000;
    this.maxSubscribersPerRun = options?.maxSubscribersPerRun ?? 10;
  }

  begin(sessionId: string): void {
    this.evictIfNeeded(sessionId);
    this.runs.set(sessionId, {
      sessionId,
      createdAt: Date.now(),
      messages: [],
      subscribers: new Set(),
    });
  }

  publish(sessionId: string, message: ConversationRunMessage): void {
    const run = this.runs.get(sessionId);
    if (!run) {
      return;
    }

    run.messages.push(message);
    const overflow = run.messages.length - this.maxEventsPerRun;
    if (overflow > 0) {
      run.messages.splice(0, overflow);
    }

    for (const subscriber of run.subscribers) {
      subscriber(message);
    }
  }

  getBufferedMessages(sessionId: string): ConversationRunMessage[] | null {
    const run = this.runs.get(sessionId);
    if (!run) {
      return null;
    }

    return [...run.messages];
  }

  attachWithBufferedSnapshot(
    sessionId: string,
    subscriber: Subscriber,
  ): ConversationRunAttachment | null {
    const run = this.runs.get(sessionId);
    if (!run) {
      return null;
    }

    if (run.subscribers.size >= this.maxSubscribersPerRun) {
      console.warn(`Conversation run subscriber cap reached for ${sessionId}`);
      return null;
    }

    const bufferedMessages = [...run.messages];
    run.subscribers.add(subscriber);

    return {
      bufferedMessages,
      detach: () => {
        run.subscribers.delete(subscriber);
      },
    };
  }

  attach(
    sessionId: string,
    subscriber: Subscriber,
    options?: AttachOptions,
  ): (() => void) | null {
    const attachment = this.attachWithBufferedSnapshot(sessionId, subscriber);
    if (!attachment) {
      return null;
    }

    if (options?.replayBuffered !== false) {
      for (const message of attachment.bufferedMessages) {
        subscriber(message);
      }
    }

    return attachment.detach;
  }

  complete(sessionId: string): void {
    const run = this.runs.get(sessionId);
    if (!run) {
      return;
    }

    run.subscribers.clear();
    this.runs.delete(sessionId);
  }

  private evictIfNeeded(incomingSessionId: string): void {
    if (this.runs.has(incomingSessionId)) {
      this.complete(incomingSessionId);
      return;
    }

    while (this.runs.size >= this.maxRuns) {
      const oldestEntry = this.runs.entries().next().value;
      if (!oldestEntry) {
        return;
      }

      const [sessionId, run] = oldestEntry;
      run.subscribers.clear();
      this.runs.delete(sessionId);
      console.warn(`Evicted active conversation run for ${sessionId} due to registry cap`);
    }
  }
}
