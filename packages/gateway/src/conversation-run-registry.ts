export type ConversationRunMessage =
  | { type: "kernel:init"; sessionId: string; requestId?: string; eventId?: string }
  | { type: "kernel:text"; text: string; requestId?: string; eventId?: string }
  | { type: "kernel:tool_start"; tool: string; requestId?: string; eventId?: string }
  | { type: "kernel:tool_end"; input?: Record<string, unknown>; requestId?: string; eventId?: string }
  | { type: "kernel:result"; data: unknown; requestId?: string; eventId?: string }
  | { type: "kernel:error"; message: string; requestId?: string; eventId?: string }
  | { type: "kernel:aborted"; requestId?: string; eventId?: string }
  | {
      type: "approval:request";
      id: string;
      toolName: string;
      args: unknown;
      timeout: number;
      requestId?: string;
      eventId?: string;
    };

export interface ConversationRunRegistryOptions {
  maxRuns?: number;
  maxEventsPerRun?: number;
  maxSubscribersPerRun?: number;
  completedRunRetentionMs?: number;
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
  completedAt: number | null;
}

export class ConversationRunRegistry {
  private readonly runs = new Map<string, RunState>();
  private readonly maxRuns: number;
  private readonly maxEventsPerRun: number;
  private readonly maxSubscribersPerRun: number;
  private readonly completedRunRetentionMs: number;

  constructor(options?: ConversationRunRegistryOptions) {
    this.maxRuns = options?.maxRuns ?? 20;
    this.maxEventsPerRun = options?.maxEventsPerRun ?? 2_000;
    this.maxSubscribersPerRun = options?.maxSubscribersPerRun ?? 10;
    this.completedRunRetentionMs = options?.completedRunRetentionMs ?? 30_000;
  }

  begin(sessionId: string): void {
    this.evictExpiredCompletedRuns();
    this.evictIfNeeded(sessionId);
    this.runs.set(sessionId, {
      sessionId,
      createdAt: Date.now(),
      messages: [],
      subscribers: new Set(),
      completedAt: null,
    });
  }

  publish(sessionId: string, message: ConversationRunMessage): void {
    const run = this.runs.get(sessionId);
    if (!run || run.completedAt !== null) {
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
    this.evictExpiredCompletedRuns();
    const run = this.runs.get(sessionId);
    if (!run) {
      return null;
    }

    return [...run.messages];
  }

  hasActiveSubscribers(sessionId: string): boolean {
    const run = this.runs.get(sessionId);
    return Boolean(run && run.completedAt === null && run.subscribers.size > 0);
  }

  attachWithBufferedSnapshot(
    sessionId: string,
    subscriber: Subscriber,
  ): ConversationRunAttachment | null {
    this.evictExpiredCompletedRuns();
    const run = this.runs.get(sessionId);
    if (!run) {
      return null;
    }

    if (run.completedAt !== null) {
      return {
        bufferedMessages: [...run.messages],
        detach: () => {},
      };
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
    run.completedAt = Date.now();
  }

  private evictIfNeeded(incomingSessionId: string): void {
    if (this.runs.has(incomingSessionId)) {
      this.complete(incomingSessionId);
      return;
    }

    while (this.runs.size >= this.maxRuns) {
      const evictEntry = this.findOldestCompletedRunEntry()
        ?? this.runs.entries().next().value;
      if (!evictEntry) {
        return;
      }

      const [sessionId, run] = evictEntry;
      run.subscribers.clear();
      this.runs.delete(sessionId);
      console.warn(`Evicted conversation run for ${sessionId} due to registry cap`);
    }
  }

  private findOldestCompletedRunEntry(): [string, RunState] | undefined {
    for (const entry of this.runs) {
      if (entry[1].completedAt !== null) {
        return entry;
      }
    }

    return undefined;
  }

  private evictExpiredCompletedRuns(now = Date.now()): void {
    for (const [sessionId, run] of this.runs) {
      if (run.completedAt !== null && now - run.completedAt >= this.completedRunRetentionMs) {
        this.runs.delete(sessionId);
      }
    }
  }
}
