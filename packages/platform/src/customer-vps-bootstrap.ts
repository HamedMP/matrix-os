import { z } from 'zod/v4';

export const CUSTOMER_VPS_BOOTSTRAP_STAGES = [
  'cloud_init_started',
  'packages_ready',
  'bundle_downloaded',
  'bundle_installed',
  'database_ready',
  'gateway_starting',
  'registered',
] as const;

export const CustomerVpsBootstrapStageSchema = z.enum(CUSTOMER_VPS_BOOTSTRAP_STAGES);
export type CustomerVpsBootstrapStage = z.infer<typeof CustomerVpsBootstrapStageSchema>;

export function customerVpsBootstrapStageRank(stage: CustomerVpsBootstrapStage): number {
  return CUSTOMER_VPS_BOOTSTRAP_STAGES.indexOf(stage) + 1;
}
