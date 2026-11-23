import { ExternalMcpApprovalsPanel, type ExternalMcpApprovalsTransport } from "@matrix-os/ui";
import { useMemo } from "react";
import { useConnection } from "../../stores/connection";

/** Same response cap as the web transport. */
const MAX_APPROVAL_RESPONSE_BYTES = 256 * 1024;

/** Electron Desktop: owner approvals for external MCP writes, through the trusted gateway client (spec 2691, layer 7). */
export default function ExternalMcpApprovalsSection() {
  const api = useConnection((state) => state.api);
  const transport = useMemo<ExternalMcpApprovalsTransport | null>(() => api ? {
    list: () => api.get<unknown>("/api/mcp-servers/core/external-approvals", { maxBytes: MAX_APPROVAL_RESPONSE_BYTES }),
    decide: (approvalId, decision) => api.post<unknown>(`/api/mcp-servers/core/external-approvals/${encodeURIComponent(approvalId)}`, { decision }, { maxBytes: MAX_APPROVAL_RESPONSE_BYTES }),
  } : null, [api]);
  return <div className="mt-8"><ExternalMcpApprovalsPanel transport={transport} /></div>;
}
