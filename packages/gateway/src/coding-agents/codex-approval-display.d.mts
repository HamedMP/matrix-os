import type { AgentApprovalRequest } from "@matrix-os/contracts";
export function codexApprovalDisplay(method: string, params: Record<string, unknown>, context?: {
  writableRoots?: readonly string[];
  filePreview?: AgentApprovalRequest["preview"];
}): Pick<AgentApprovalRequest, "title" | "safeDescription" | "actionKind" | "risk" | "preview">;
export function codexFileChangePreview(changes: unknown, roots?: readonly string[]): AgentApprovalRequest["preview"];
