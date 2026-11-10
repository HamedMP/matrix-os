export interface CodexSendTiming {
  now(): number;
  mark(stage: string, startedAt: number, index?: number): void;
  runnerBoot(): void;
  beginTurn(index: number): void;
  firstProviderDelta(): void;
  firstPersistedText(): void;
}

export function createCodexSendTiming(
  sessionId: string,
  write?: (line: string) => void,
  enabled?: boolean,
): CodexSendTiming;
