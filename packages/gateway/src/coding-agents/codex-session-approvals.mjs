const SESSION_APPROVAL_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
]);

/** @param {unknown} kind */
export function isSupportedCodexCommandApprovalKind(kind) {
  // Older servers omit kind. Matrix does not opt into humanCommand checkpoints.
  return kind === undefined || kind === "command" || kind === "writeStdin";
}

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
