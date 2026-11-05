import { sql } from "kysely";
import { PAIR_PREVIEW_HANDLE_PATTERN } from "@matrix-os/clerk-sync";

/** Reserved names only deny ordinary authority; the member ledger also excludes
 * pairs whose machine metadata is inconsistent. Both filters run before LIMIT. */
export const ordinaryMachinePredicate = sql<boolean>`
  user_machines.handle !~ ${PAIR_PREVIEW_HANDLE_PATTERN.source}
  AND NOT EXISTS (SELECT 1 FROM preview_pair_members pair_filter
    WHERE pair_filter.machine_id = user_machines.machine_id)`;

/** Preserve orphan-job reconciliation while excluding reserved/ledger-owned
 * pair jobs. A malformed pair handle cannot enter the customer dispatcher. */
export const ordinaryProvisioningJobPredicate = sql<boolean>`
  NOT EXISTS (SELECT 1 FROM preview_pair_members pair_filter
    WHERE pair_filter.machine_id = provisioning_jobs.machine_id)
  AND NOT EXISTS (SELECT 1 FROM user_machines pair_machine
    WHERE pair_machine.machine_id = provisioning_jobs.machine_id
      AND pair_machine.handle ~ ${PAIR_PREVIEW_HANDLE_PATTERN.source})`;

/** A queue reason is not pair authority. Exclude every known pair marker or
 * owned machine, including compensations created before canonical retirement. */
export const ordinaryProviderDeletionPredicate = sql<boolean>`
  provider_deletion_queue.reason <> 'preview_pair_retire'
  AND (provider_deletion_queue.handle IS NULL OR provider_deletion_queue.handle !~ ${PAIR_PREVIEW_HANDLE_PATTERN.source})
  AND NOT EXISTS (SELECT 1 FROM preview_pair_members pair_filter
    WHERE pair_filter.machine_id = provider_deletion_queue.machine_id)
  AND NOT EXISTS (SELECT 1 FROM user_machines pair_machine
    WHERE pair_machine.machine_id = provider_deletion_queue.machine_id
      AND pair_machine.handle ~ ${PAIR_PREVIEW_HANDLE_PATTERN.source})`;
