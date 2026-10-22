export class QualifiedFundedError extends Error {
  constructor(readonly status: 400 | 401 | 503 = 503) { super('Qualified AI unavailable'); this.name = 'QualifiedFundedError'; }
}
export function assertQualifiedLive(signal: AbortSignal, deadlineAt: number): void {
  if (signal.aborted || Date.now() >= deadlineAt) throw new QualifiedFundedError();
}
