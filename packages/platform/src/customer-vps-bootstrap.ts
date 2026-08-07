import { z } from 'zod/v4';

export const CUSTOMER_VPS_BOOTSTRAP_STAGES = [
  'cloud_init_started',
  'packages_ready',
  'bundle_downloaded',
  'bundle_installed',
  'database_ready',
  'restore_starting',
  'restore_ready',
  'gateway_starting',
  'gateway_preflight_checking_exec',
  'gateway_preflight_checking_paths',
  'gateway_preflight_checking_environment',
  'gateway_preflight_ready',
  'gateway_unit_failed_chdir',
  'gateway_unit_failed_exec',
  'gateway_unit_failed_user',
  'gateway_unit_failed_group',
  'gateway_unit_failed_environment',
  'gateway_unit_failed_exit',
  'gateway_unit_failed_timeout',
  'gateway_unit_failed_resource',
  'gateway_unit_failed_signal',
  'gateway_unit_failed_other',
  'gateway_unit_started',
  'gateway_wrapper_started',
  'gateway_home_ready',
  'gateway_launch_ready',
  'gateway_process_started',
  'gateway_healthy',
  'registration_ready',
  'registered',
] as const;

export const CustomerVpsBootstrapStageSchema = z.enum(CUSTOMER_VPS_BOOTSTRAP_STAGES);
export type CustomerVpsBootstrapStage = z.infer<typeof CustomerVpsBootstrapStageSchema>;

export function customerVpsBootstrapStageRank(stage: CustomerVpsBootstrapStage): number {
  return CUSTOMER_VPS_BOOTSTRAP_STAGES.indexOf(stage) + 1;
}
