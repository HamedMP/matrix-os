export function isSupportedCodexCommandApprovalKind(kind: unknown): boolean;

export function createCodexSessionApprovalGrants(): {
  grant(method: string): void;
  decisionFor<T>(method: string, nativeDecisionByMatrixDecision: {
    approve_for_session?: T;
    approve?: T;
  }): T | undefined;
};
