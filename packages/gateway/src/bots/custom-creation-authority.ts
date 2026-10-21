import { createHash } from 'node:crypto';

/** Reserved durable operation namespace; client-controlled recipe references are not provenance. */
export const MANAGED_CUSTOM_OPERATION_PREFIX = 'req_managedcustom_';
export function managedCustomOperationRequestId(ownerId: string, clientRequestId: string): string {
  return MANAGED_CUSTOM_OPERATION_PREFIX + createHash('sha256').update(JSON.stringify([ownerId, clientRequestId])).digest('hex');
}
export function isManagedCustomOperationRequestId(value: string): boolean {
  return value.startsWith(MANAGED_CUSTOM_OPERATION_PREFIX);
}
