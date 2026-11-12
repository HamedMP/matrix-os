import { createHmac } from "node:crypto";
import { parseSupervisedBrowserDevScope, type BrowserDecisionTuple, type SupervisedBrowserDevScope } from "@matrix-os/contracts";

export type BrowserApprovalPolicy = { kind: "disabled" } | { kind: "global" } | { kind: "scoped"; scope: SupervisedBrowserDevScope };

export function resolveBrowserApprovalPolicy(env: NodeJS.ProcessEnv): BrowserApprovalPolicy {
  const parsed = parseSupervisedBrowserDevScope(env.MATRIX_SUPERVISED_BROWSER_DEV_SCOPE);
  const globalEnabled = env.MATRIX_SUPERVISED_BROWSER_APPROVALS_ENABLED === "true";
  if (parsed.kind === "absent") return globalEnabled ? { kind: "global" } : { kind: "disabled" };
  if (parsed.kind === "invalid" || globalEnabled) return { kind: "disabled" };
  return parsed;
}

export function matchesDevBrowserDecision(scope: SupervisedBrowserDevScope, tuple: BrowserDecisionTuple, now = Date.now()): boolean {
  return now < scope.expiresAt && tuple.handle === scope.handle && tuple.runtimeSlot === scope.runtimeSlot
    && tuple.actorId === scope.ownerId && tuple.chatId === scope.chatId && tuple.browserDecision !== "allow_in_chat";
}

/** A proof cannot move to a replacement machine or another activation window. */
export function devBrowserProofKey(secret: string, scope: SupervisedBrowserDevScope): string {
  return createHmac("sha256", secret).update("matrix-browser-dev-chat-scope:v1\0")
    .update(JSON.stringify([scope.handle, scope.machineId, scope.ownerId, scope.runtimeSlot, scope.chatId, scope.expiresAt])).digest("hex");
}
