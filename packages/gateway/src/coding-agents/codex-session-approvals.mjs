const SESSION_APPROVAL_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
]);

export function createCodexSessionApprovalGrants() {
  const grantedMethods = new Set();
  return {
    grant(method, nativeDecision) {
      if (SESSION_APPROVAL_METHODS.has(method) && nativeDecision === "acceptForSession") {
        grantedMethods.add(method);
      }
    },
    decisionFor(method, nativeDecisionByMatrixDecision) {
      if (!grantedMethods.has(method)) return undefined;
      const nativeDecision = nativeDecisionByMatrixDecision.approve_for_session;
      return nativeDecision === "acceptForSession" ? nativeDecision : undefined;
    },
  };
}
