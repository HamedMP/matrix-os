import { getUserMachine, type PlatformDB } from "../db.js";
import type { CustomerVpsService } from "../customer-vps.js";
import type { HetznerClient } from "../customer-vps-hetzner.js";
import { createCustomerVpsContext } from "../customer-vps-context.js";
import { loadCustomerVpsConfig } from "../customer-vps-config.js";
import { createCustomerVpsRegistration } from "../customer-vps-registration.js";
import { createNoopCustomerVpsSystemStore } from "../customer-vps-r2.js";
import { CustomerVpsError } from "../customer-vps-errors.js";
import { statusResponse } from "../customer-vps-support.js";
import { loadPreviewPairCandidateRuntimeProfile } from "./candidate-profile.js";

/** Existing registration and status producers, without constructing a provider
 * client or exposing a method that can create/recover/delete/charge a machine. */
export function createPreviewPairRuntimeOnlyService(options: { db: PlatformDB; env: NodeJS.ProcessEnv; now?: () => Date }): CustomerVpsService | undefined {
  const profile = loadPreviewPairCandidateRuntimeProfile(options.env);
  if (!profile) return undefined;
  const deny = async (): Promise<never> => { throw new CustomerVpsError(503, "provider_unavailable", "Preview computer management is unavailable"); };
  const provider: HetznerClient = { createServer: deny, getServer: deny, shutdownServer: deny, powerOffServer: deny,
    powerOnServer: deny, resizeServer: deny, deleteServer: deny, createSnapshot: deny, getImage: deny,
    listImagesByLabel: deny, deleteImage: deny, getAction: deny, withSignal: () => provider };
  const context = createCustomerVpsContext({ db: options.db, config: loadCustomerVpsConfig(options.env),
    hetzner: provider, systemStore: createNoopCustomerVpsSystemStore(), now: options.now });
  const registration = createCustomerVpsRegistration(context);
  async function bound(machineId: string, register = false) {
    const machine = await getUserMachine(options.db, machineId);
    if (!machine || machine.deletedAt || machine.provisioningClass !== "preview" || machine.accessClerkUserIds.length
      || machine.runtimeSlot !== machine.handle || !profile!.handles.includes(machine.handle)) {
      throw new CustomerVpsError(register ? 401 : 404, register ? "registration_rejected" : "not_found", "Preview computer is unavailable");
    }
    return machine;
  }
  const status: CustomerVpsService["status"] = async machineId => statusResponse(await bound(machineId));
  return {
    register: async (token, input) => { await bound(input.machineId, true); return registration.register(token, input); },
    status,
    async listAllMachines() {
      const rows = await options.db.executor.selectFrom("user_machines").select("machine_id")
        .where("handle", "in", [...profile.handles]).where("deleted_at", "is", null).limit(3).execute();
      if (rows.length > 2) throw new CustomerVpsError(503, "invalid_state", "Preview computers are unavailable");
      return Promise.all(rows.map(row => status(row.machine_id)));
    },
    provision: deny, provisionForCheckout: deny, provisionPreview: deny, startPrivatePreview: deny,
    updatePrivatePreview: deny, recover: deny, resize: deny, suspendForBilling: deny, resumeForBilling: deny,
    delete: deny, deploy: deny, activateSpeech: deny, dispatchProvisioningJobs: deny, reconcileProvisioning: deny,
  };
}
