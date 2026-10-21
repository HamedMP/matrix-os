import { isCustomMcpApprovalSubmitPath, mintCustomMcpApprovalProof } from "./custom-mcp-approval-proof.js";
import { isBrowserGrantRevokePath, mintBrowserApprovalProof } from "./browser-chat-approval-proof.js";
import { hasVerifiedPreviewUserSession } from "./preview-drive-turn-proof.js";
import { isPreviewMachine } from "./customer-vps-preview.js";
import type { UserMachineRecord } from "./db.js";
import type { AppDomainIdentity } from "./session-routing-identity.js";

/** Bounded owner body reader shared by legacy integration and new browser proofs.
 * Production explicitly passes the default-off browser feature gate.
 */
export async function authenticatedApprovalProxyProof(input: {
  request: Request; method: string; path: string; handle: string;
  identity: AppDomainIdentity; platformSecret: string; timeoutMs?: number; browserApprovalsEnabled?: boolean;
  machine?: Pick<UserMachineRecord, "handle" | "runtimeSlot" | "provisioningClass">;
}): Promise<string | null | { status: 408 | 413 }> {
  if (!input.platformSecret || input.identity.source !== "auth"
    || (input.machine && isPreviewMachine(input.machine) && !hasVerifiedPreviewUserSession(input.identity))
    || !(isCustomMcpApprovalSubmitPath(input.method, input.path) || isBrowserGrantRevokePath(input.method, input.path))) return null;
  const reader = input.request.clone().body?.getReader();
  if (!reader) return null;
  const cancel = () => {
    void reader.cancel().catch(error => console.warn("[platform] Approval body cancellation failed", error instanceof Error ? error.name : typeof error));
    void input.request.body?.cancel().catch(error => console.warn("[platform] Approval body cancellation failed", error instanceof Error ? error.name : typeof error));
  };
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("ApprovalBodyTimeout")), input.timeoutMs ?? 5000);
    timer.unref?.();
  });
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), deadline]);
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > 4000) { cancel(); return { status: 413 }; }
      chunks.push(next.value);
    }
    const body = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
    if (input.machine && isPreviewMachine(input.machine) && !hasVerifiedPreviewUserSession(input.identity)) return null;
    if (input.browserApprovalsEnabled === true && input.machine && input.identity.handle === input.handle
      && input.machine.handle === input.handle && (!input.identity.runtimeSlot || input.identity.runtimeSlot === input.machine.runtimeSlot)) {
      const browser = mintBrowserApprovalProof({ method: input.method, path: input.path, body, secret: input.platformSecret,
        identity: { ...input.identity, handle: input.handle, runtimeSlot: input.machine.runtimeSlot } });
      if (browser) return browser;
    }
    return mintCustomMcpApprovalProof({ method: input.method, path: input.path, body, secret: input.platformSecret,
      identity: { handle: input.handle, userId: input.identity.userId, source: input.identity.source } });
  } catch (error: unknown) {
    cancel();
    if (error instanceof Error && error.message === "ApprovalBodyTimeout") return { status: 408 };
    console.warn("[platform] Approval proof unavailable", error instanceof Error ? error.name : typeof error);
    return null;
  } finally { clearTimeout(timer); }
}
