export type ConversationRunMessage =
  | { type: "kernel:init"; sessionId: string; requestId?: string }
  | { type: "kernel:text"; text: string; requestId?: string }
  | { type: "kernel:tool_start"; tool: string; requestId?: string }
  | { type: "kernel:tool_end"; input?: Record<string, unknown>; requestId?: string }
  | { type: "kernel:result"; data: Record<string, unknown>; requestId?: string }
  | { type: "kernel:error"; message: string; requestId?: string };

export interface ConversationRunRegistryOptions {
  maxRuns?: number;
  maxEventsPerRun?: number;
  maxSubscribersPerRun?: number;
}

type Subscriber = (message: ConversationRunMessage) => void;

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
    while (run.messages.length > this.maxEventsPerRun) {
      run.messages.shift();
    }

    for (const subscriber of run.subscribers) {
      subscriber(message);
    }
  }

  attach(sessionId: string, subscriber: Subscriber): (() => void) | null {
    const run = this.runs.get(sessionId);
    if (!run) {
      return null;
    }

    if (run.subscribers.size >= this.maxSubscribersPerRun) {
      throw new Error("Too many conversation stream subscribers");
    }

    for (const message of run.messages) {
      subscriber(message);
    }

    run.subscribers.add(subscriber);

    return () => {
      run.subscribers.delete(subscriber);
    };
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
