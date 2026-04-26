import { randomUUID, randomBytes } from 'node:crypto';
import type { PlatformDB, UserMachineRecord } from './db.js';
import {
  getActiveUserMachineByClerkId,
  getUserMachine,
  insertUserMachine,
  listStaleUserMachines,
  runInPlatformTransaction,
  softDeleteUserMachine,
  updateUserMachine,
} from './db.js';
import type { CustomerVpsConfig } from './customer-vps-config.js';
import {
  createRegistrationToken,
  registrationTokenMatches,
  type RegistrationToken,
} from './customer-vps-auth.js';
import type { HetznerClient } from './customer-vps-hetzner.js';
import {
  CustomerVpsError,
  genericProviderError,
  logCustomerVpsError,
  type CustomerVpsFailureCode,
} from './customer-vps-errors.js';
import { buildVpsMeta, type CustomerVpsSystemStore } from './customer-vps-r2.js';
import {
  renderCloudInitTemplate,
  type CustomerHostConfig,
} from './customer-vps-cloud-init.js';
import type {
  CustomerVpsStatus,
  ProvisionRequest,
  RegisterRequest,
  RecoverRequest,
} from './customer-vps-schema.js';

export interface ProvisionResponse {
  machineId: string;
  status: 'provisioning' | 'running';
  etaSeconds: number;
}

export interface RegisterResponse {
  registered: true;
  status: 'running';
}

export interface DeleteResponse {
  deleted: true;
  machineId: string;
  status: 'deleted';
}

export interface RecoverResponse {
  oldMachineId: string | null;
  machineId: string;
  status: 'recovering';
  etaSeconds: number;
}

export interface CustomerVpsService {
  provision(input: ProvisionRequest): Promise<ProvisionResponse>;
  register(token: string | undefined, input: RegisterRequest): Promise<RegisterResponse>;
  recover(input: RecoverRequest): Promise<RecoverResponse>;
  status(machineId: string): Promise<UserMachineRecord>;
  delete(machineId: string): Promise<DeleteResponse>;
  reconcileProvisioning(): Promise<{ checked: number; failed: number; running: number }>;
}

export interface CustomerVpsServiceDeps {
  db: PlatformDB;
  config: CustomerVpsConfig;
  hetzner: HetznerClient;
  systemStore: CustomerVpsSystemStore;
  cloudInitTemplate?: string;
  machineIdFactory?: () => string;
  tokenFactory?: (now: Date, ttlMs: number) => RegistrationToken;
  postgresPasswordFactory?: () => string;
  now?: () => Date;
}

const DEFAULT_CLOUD_INIT_TEMPLATE = [
  '#cloud-config',
  'write_files:',
  '  - path: /opt/matrix/env/host.env',
  '    content: |',
  '      MATRIX_MACHINE_ID={{machineId}}',
  '      MATRIX_CLERK_USER_ID={{clerkUserId}}',
  '      MATRIX_HANDLE={{handle}}',
  '      MATRIX_IMAGE_VERSION={{imageVersion}}',
  '      MATRIX_PLATFORM_REGISTER_URL={{platformRegisterUrl}}',
  '      MATRIX_R2_BUCKET={{r2Bucket}}',
  '      MATRIX_R2_PREFIX={{r2Prefix}}',
  '  - path: /opt/matrix/env/registration.env',
  '    permissions: "0640"',
  '    content: |',
  '      MATRIX_REGISTRATION_TOKEN={{registrationToken}}',
].join('\n');

function activeProvisionResponse(row: UserMachineRecord, etaSeconds: number): ProvisionResponse {
  if (row.status !== 'provisioning' && row.status !== 'running') {
    throw new CustomerVpsError(409, 'invalid_state', 'Machine is not provisionable');
  }
  return {
    machineId: row.machineId,
    status: row.status,
    etaSeconds,
  };
}

function toFailureCode(err: unknown): CustomerVpsFailureCode {
  return err instanceof CustomerVpsError ? err.code : genericProviderError(err).code;
}

function buildHostConfig(
  config: CustomerVpsConfig,
  input: ProvisionRequest,
  machineId: string,
  registrationToken: string,
  postgresPassword: string,
): CustomerHostConfig {
  return {
    machineId,
    clerkUserId: input.clerkUserId,
    handle: input.handle,
    imageVersion: config.imageVersion,
    platformRegisterUrl: config.platformRegisterUrl,
    registrationToken,
    r2Bucket: config.r2Bucket,
    r2Prefix: `${config.r2PrefixRoot}/${input.clerkUserId}/` as `matrixos-sync/${string}/`,
    postgresPassword,
  };
}

export function createCustomerVpsService(deps: CustomerVpsServiceDeps): CustomerVpsService {
  const machineIdFactory = deps.machineIdFactory ?? randomUUID;
  const tokenFactory = deps.tokenFactory ?? createRegistrationToken;
  const postgresPasswordFactory = deps.postgresPasswordFactory ?? (() => randomBytes(24).toString('base64url'));
  const now = deps.now ?? (() => new Date());

  return {
    async provision(input) {
      const existing = getActiveUserMachineByClerkId(deps.db, input.clerkUserId);
      if (existing) {
        return activeProvisionResponse(existing, deps.config.provisionEtaSeconds);
      }

      const currentTime = now();
      const machineId = machineIdFactory();
      const registration = tokenFactory(currentTime, deps.config.registrationTokenTtlMs);
      const postgresPassword = postgresPasswordFactory();
      const hostConfig = buildHostConfig(
        deps.config,
        input,
        machineId,
        registration.token,
        postgresPassword,
      );

      runInPlatformTransaction(deps.db, () => {
        insertUserMachine(deps.db, {
          machineId,
          clerkUserId: input.clerkUserId,
          handle: input.handle,
          status: 'provisioning',
          imageVersion: deps.config.imageVersion,
          registrationTokenHash: registration.hash,
          registrationTokenExpiresAt: registration.expiresAt,
          provisionedAt: currentTime.toISOString(),
        });
      });

      const userData = renderCloudInitTemplate(
        deps.cloudInitTemplate ?? DEFAULT_CLOUD_INIT_TEMPLATE,
        hostConfig,
      );

      try {
        const server = await deps.hetzner.createServer({
          name: `matrix-${input.handle}`,
          userData,
          labels: {
            app: 'matrix-os',
            clerk_user_id: input.clerkUserId,
            machine_id: machineId,
          },
        });
        updateUserMachine(deps.db, machineId, {
          hetznerServerId: server.id,
          publicIPv4: server.publicIPv4,
          publicIPv6: server.publicIPv6,
        });
      } catch (err: unknown) {
        const mapped = genericProviderError(err);
        updateUserMachine(deps.db, machineId, {
          status: 'failed',
          failureCode: toFailureCode(err),
          failureAt: now().toISOString(),
        });
        throw mapped;
      }

      return {
        machineId,
        status: 'provisioning',
        etaSeconds: deps.config.provisionEtaSeconds,
      };
    },

    async register(token, input) {
      const row = getUserMachine(deps.db, input.machineId);
      if (!row) {
        throw new CustomerVpsError(404, 'not_found', 'Machine not found');
      }
      if (row.status !== 'provisioning' && row.status !== 'recovering') {
        throw new CustomerVpsError(409, 'invalid_state', 'Machine cannot register');
      }
      if (row.hetznerServerId !== input.hetznerServerId) {
        throw new CustomerVpsError(401, 'registration_rejected', 'Registration rejected');
      }
      if (!row.registrationTokenExpiresAt || new Date(row.registrationTokenExpiresAt).getTime() < now().getTime()) {
        throw new CustomerVpsError(401, 'registration_rejected', 'Registration rejected');
      }
      if (!registrationTokenMatches(token, row.registrationTokenHash)) {
        throw new CustomerVpsError(401, 'registration_rejected', 'Registration rejected');
      }

      const lastSeenAt = now().toISOString();
      runInPlatformTransaction(deps.db, () => {
        updateUserMachine(deps.db, input.machineId, {
          status: 'running',
          publicIPv4: input.publicIPv4,
          publicIPv6: input.publicIPv6,
          imageVersion: input.imageVersion,
          lastSeenAt,
          registrationTokenHash: null,
          registrationTokenExpiresAt: null,
          failureCode: null,
          failureAt: null,
        });
      });

      const updated = getUserMachine(deps.db, input.machineId);
      if (updated) {
        try {
          await deps.systemStore.writeVpsMeta(buildVpsMeta(updated, lastSeenAt));
        } catch (err: unknown) {
          logCustomerVpsError('write vps-meta failed', err);
        }
      }

      return { registered: true, status: 'running' };
    },

    async recover(input) {
      const existing = getActiveUserMachineByClerkId(deps.db, input.clerkUserId);
      if (!existing) {
        throw new CustomerVpsError(404, 'not_found', 'Machine not found');
      }

      if (!input.allowEmpty && !(await deps.systemStore.hasDbLatest(input.clerkUserId))) {
        throw new CustomerVpsError(409, 'invalid_state', 'No backup snapshot available');
      }

      const oldMachineId = existing.machineId;
      const oldServerId = existing.hetznerServerId;
      const currentTime = now();
      const machineId = machineIdFactory();
      const registration = tokenFactory(currentTime, deps.config.registrationTokenTtlMs);
      const postgresPassword = postgresPasswordFactory();
      const hostConfig = buildHostConfig(
        deps.config,
        { clerkUserId: existing.clerkUserId, handle: existing.handle },
        machineId,
        registration.token,
        postgresPassword,
      );

      runInPlatformTransaction(deps.db, () => {
        updateUserMachine(deps.db, oldMachineId, {
          machineId,
          status: 'recovering',
          hetznerServerId: null,
          publicIPv4: null,
          publicIPv6: null,
          imageVersion: deps.config.imageVersion,
          registrationTokenHash: registration.hash,
          registrationTokenExpiresAt: registration.expiresAt,
          provisionedAt: currentTime.toISOString(),
          lastSeenAt: null,
          deletedAt: null,
          failureCode: null,
          failureAt: null,
        });
      });

      try {
        if (oldServerId) {
          await deps.hetzner.deleteServer(oldServerId);
        }

        const userData = renderCloudInitTemplate(
          deps.cloudInitTemplate ?? DEFAULT_CLOUD_INIT_TEMPLATE,
          hostConfig,
        );
        const server = await deps.hetzner.createServer({
          name: `matrix-${existing.handle}`,
          userData,
          labels: {
            app: 'matrix-os',
            clerk_user_id: existing.clerkUserId,
            machine_id: machineId,
          },
        });
        updateUserMachine(deps.db, machineId, {
          hetznerServerId: server.id,
          publicIPv4: server.publicIPv4,
          publicIPv6: server.publicIPv6,
        });
      } catch (err: unknown) {
        const mapped = genericProviderError(err);
        updateUserMachine(deps.db, machineId, {
          status: 'failed',
          failureCode: toFailureCode(err),
          failureAt: now().toISOString(),
        });
        throw mapped;
      }

      return {
        oldMachineId,
        machineId,
        status: 'recovering',
        etaSeconds: deps.config.provisionEtaSeconds,
      };
    },

    async status(machineId) {
      const row = getUserMachine(deps.db, machineId);
      if (!row) {
        throw new CustomerVpsError(404, 'not_found', 'Machine not found');
      }
      return row;
    },

    async delete(machineId) {
      const row = getUserMachine(deps.db, machineId);
      if (!row || row.deletedAt) {
        throw new CustomerVpsError(404, 'not_found', 'Machine not found');
      }
      if (row.hetznerServerId) {
        await deps.hetzner.deleteServer(row.hetznerServerId);
      }
      softDeleteUserMachine(deps.db, machineId, now().toISOString());
      return { deleted: true, machineId, status: 'deleted' };
    },

    async reconcileProvisioning() {
      const staleBefore = new Date(now().getTime() - deps.config.reconciliationStaleAfterMs).toISOString();
      const rows = listStaleUserMachines(
        deps.db,
        ['provisioning', 'recovering'],
        staleBefore,
        deps.config.reconciliationBatchSize,
      );
      let failed = 0;
      let running = 0;
      for (const row of rows) {
        if (!row.hetznerServerId) {
          updateUserMachine(deps.db, row.machineId, {
            status: 'failed',
            failureCode: 'provider_unavailable',
            failureAt: now().toISOString(),
          });
          failed += 1;
          continue;
        }
        const server = await deps.hetzner.getServer(row.hetznerServerId);
        if (!server) {
          updateUserMachine(deps.db, row.machineId, {
            status: 'failed',
            failureCode: 'not_found',
            failureAt: now().toISOString(),
          });
          failed += 1;
          continue;
        }
        if (server.status === 'running' && server.publicIPv4) {
          updateUserMachine(deps.db, row.machineId, {
            publicIPv4: server.publicIPv4,
            publicIPv6: server.publicIPv6,
          });
          running += 1;
        }
      }
      return { checked: rows.length, failed, running };
    },
  };
}
