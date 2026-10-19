import { TASK_CRM_WRITE_ACTIONS } from "./task-crm-writes.js";
import { DOCUMENT_WRITE_ACTIONS } from "./document-writes.js";
import { MICROSOFT_WRITE_ACTIONS } from "./microsoft-writes.js";
import { FILE_COMMUNICATION_WRITE_ACTIONS } from "./file-communication-writes.js";
import { FINANCE_WRITE_ACTIONS } from "./finance-writes.js";
import type { ServiceAction } from "./types.js";

/** Reviewed actions are composed once for every renderer and execution route. */
export function integrationWriteActions(serviceId: string): Record<string, ServiceAction> {
  return Object.assign({}, ...[TASK_CRM_WRITE_ACTIONS, DOCUMENT_WRITE_ACTIONS,
    MICROSOFT_WRITE_ACTIONS, FILE_COMMUNICATION_WRITE_ACTIONS, FINANCE_WRITE_ACTIONS].map(map => map[serviceId] ?? {}));
}
