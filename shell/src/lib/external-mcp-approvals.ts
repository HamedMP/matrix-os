import { createExternalMcpApprovalsFetchTransport } from "@matrix-os/ui";
import { getGatewayUrl } from "@/lib/gateway";

/** One stable transport for the Integrations panel and the notification pill (spec 2691, layer 7). */
export const shellExternalMcpApprovals = createExternalMcpApprovalsFetchTransport({ baseUrl: getGatewayUrl() });
