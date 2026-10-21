import type { BrowserApprovalControl } from "./browser-approval-control.js";
import type { CanonicalProviderRunInput } from "./provider-adapter.js";

/** Register only personal supervised runs with the canonical signed authority. */
export function registerBrowserApprovalRun(
  control: BrowserApprovalControl | undefined,
  input: CanonicalProviderRunInput,
  driverKind: string,
  publish: Parameters<BrowserApprovalControl["registerRun"]>[0]["publish"],
) {
  const harness = driverKind === "matrix_pi" ? "pi" : driverKind === "codex" || driverKind === "claude_code" ? driverKind : undefined;
  if (!control || !harness || input.sharedScopeId || input.owner.type !== "personal"
    || input.permissionMode !== "supervised" || input.interactionMode !== "default") return undefined;
  return control.registerRun({
    binding: { ownerId: input.owner.ownerId, chatId: input.chatId, runId: input.runId, harness },
    signal: input.signal,
    publish,
  });
}
