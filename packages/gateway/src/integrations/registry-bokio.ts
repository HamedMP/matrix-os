import { BOKIO_ACTIONS } from "@matrix-os/contracts/bokio-integration";
import type { ServiceDefinition } from "./types.js";

/** Executed by the owner/company-bound Matrix OAuth broker, not an MCP server. */
export const BOKIO_SERVICE: ServiceDefinition = {
  id: "bokio", name: "Bokio", category: "finance", connectorKind: "managed_oauth",
  authType: "oauth", icon: "receipt", logoUrl: "https://www.bokio.se/assets/images/icons/favicon.ico",
  description: "Read your company's invoices, customers, bookkeeping and receipts.",
  actions: BOKIO_ACTIONS,
};
