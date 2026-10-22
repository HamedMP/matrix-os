import type { FundedAiPriorityReason } from '@matrix-os/contracts';
export class QualifiedFundedError extends Error {
  constructor(readonly status: 400 | 401 | 429 | 503 = 503, readonly priorityReason?: FundedAiPriorityReason) { super('Qualified AI unavailable'); this.name = 'QualifiedFundedError'; }
}
export function assertQualifiedLive(signal: AbortSignal, deadlineAt: number): void {
  if (signal.aborted || Date.now() >= deadlineAt) throw new QualifiedFundedError();
}
