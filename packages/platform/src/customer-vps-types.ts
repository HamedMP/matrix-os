/** Public customer VPS service contracts, split from customer-vps.ts. */
import type { PlatformDB } from './db.js';
import type { CustomerVpsConfig } from './customer-vps-config.js';
import { type RegistrationToken } from './customer-vps-auth.js';
import type { HetznerClient } from './customer-vps-hetzner.js';
import { type CustomerVpsSystemStore } from './customer-vps-r2.js';
import {
  type CustomerVpsStatus,
  type PreviewProvisionInput,
  type ProvisionRequest,
  type RegisterRequest,
  type RecoverRequest,
  type ResizeMachineRequest,
} from './customer-vps-schema.js';
import { type BillingEntitlement } from './billing.js';
import { type NewProvisioningJob } from './customer-vps-provisioning-jobs.js';

export interface ProvisionResponse {
  machineId: string;
  status: 'provisioning' | 'running';
  etaSeconds: number;
}

export interface ProvisionOptions {
  dispatch?: 'wait' | 'detached';
}

export interface RegisterResponse {
  registered: true;
  status: 'running';
  warnings?: string[];
}

export interface DeleteResponse {
  deleted: true;
  machineId: string;
  status: 'deleted';
}

export interface RecoverResponse {
  oldMachineId: string | null;
  machineId: string;
  runtimeSlot: string;
  status: 'recovering';
  etaSeconds: number;
}

export interface ResizeResponse {
  machineId: string;
  serverType: string;
  status: 'running';
}

export interface StatusResponse {
  machineId: string;
  clerkUserId: string;
  handle: string;
  runtimeSlot: string;
  status: CustomerVpsStatus;
  imageVersion: string | null;
  publicIPv4: string | null;
  publicIPv6: string | null;
  provisionedAt: string;
  lastSeenAt: string | null;
  deletedAt: string | null;
  failureCode: string | null;
  failureAt: string | null;
}

export interface DeployResult {
  triggered: number;
  failed: number;
  results: Array<{ machineId: string; handle: string; status: 'triggered' | 'failed'; error?: string }>;
}

export interface DeployTarget {
  version?: string;
  channel?: 'stable' | 'canary' | 'beta' | 'dev';
  handle?: string;
}

export interface CustomerVpsService {
  provision(input: ProvisionRequest, options?: ProvisionOptions): Promise<ProvisionResponse>;
  provisionForCheckout(
    input: ProvisionRequest,
    prebillingIntentId: string,
    options?: ProvisionOptions,
  ): Promise<ProvisionResponse>;
  provisionPreview(input: PreviewProvisionInput): Promise<ProvisionResponse>;
  register(token: string | undefined, input: RegisterRequest): Promise<RegisterResponse>;
  recover(input: RecoverRequest): Promise<RecoverResponse>;
  resize(input: ResizeMachineRequest & { machineId: string }): Promise<ResizeResponse>;
  suspendForBilling(machineId: string, shouldContinue?: () => Promise<boolean>): Promise<void>;
  resumeForBilling(machineId: string, shouldContinue?: () => Promise<boolean>): Promise<void>;
  status(machineId: string): Promise<StatusResponse>;
  delete(machineId: string): Promise<DeleteResponse>;
  deploy(target?: DeployTarget): Promise<DeployResult>;
  listAllMachines(): Promise<StatusResponse[]>;
  dispatchProvisioningJobs(): Promise<{ checked: number; completed: number; failed: number }>;
  setPrebillingFallbackReconciler?(reconcile: (() => Promise<unknown>) | undefined): void;
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
  provisioningJobIdFactory?: () => string;
  enqueueProvisioningJob?: (db: PlatformDB, job: NewProvisioningJob) => Promise<void>;
  scheduleProvisioningDispatch?: (dispatch: () => Promise<void>) => void;
  fetchDispatcher?: import('undici').Dispatcher;
  resolveBillingEntitlement?: (
    db: PlatformDB,
    clerkUserId: string,
    runtimeSlot: string,
  ) => Promise<BillingEntitlement | null | undefined>;
}
