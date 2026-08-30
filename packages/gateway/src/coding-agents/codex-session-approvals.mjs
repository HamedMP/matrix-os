const SESSION_APPROVAL_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
]);

export function createCodexSessionApprovalGrants() {
  const grantedMethods = new Set();
  return {
    grant(method) {
      if (SESSION_APPROVAL_METHODS.has(method)) grantedMethods.add(method);
    },
    decisionFor(method, nativeDecisionByMatrixDecision) {
      if (!grantedMethods.has(method)) return undefined;
      return nativeDecisionByMatrixDecision.approve_for_session ??
        nativeDecisionByMatrixDecision.approve;
    },
  };
}
