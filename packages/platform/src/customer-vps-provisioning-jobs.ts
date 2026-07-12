import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { z } from 'zod/v4';
import type { PlatformDB } from './db.js';

const MAX_PROVISIONING_JOBS = 100;
const MAX_ENCRYPTED_PAYLOAD_LENGTH = 8_192;
const PAYLOAD_VERSION = 1;
export const MAX_PROVISIONING_JOB_ATTEMPTS = 100;

const ProvisioningJobStatusSchema = z.enum(['queued', 'running', 'completed', 'failed']);
const ProvisioningPayloadSchema = z.object({
  registrationToken: z.string().min(8).max(512),
  postgresPassword: z.string().min(8).max(512),
}).strict();

const ProvisioningJobRowSchema = z.object({
  job_id: z.uuid(),
  machine_id: z.uuid(),
  status: ProvisioningJobStatusSchema,
  attempts: z.number().int().min(0).max(MAX_PROVISIONING_JOB_ATTEMPTS),
  available_at: z.string().min(1).max(64),
  claimed_at: z.string().min(1).max(64).nullable(),
  lease_expires_at: z.string().min(1).max(64).nullable(),
  encrypted_payload: z.string().max(MAX_ENCRYPTED_PAYLOAD_LENGTH).nullable(),
  last_error_code: z.string().min(1).max(64).nullable(),
  created_at: z.string().min(1).max(64),
  updated_at: z.string().min(1).max(64),
  completed_at: z.string().min(1).max(64).nullable(),
});

export interface ProvisioningJobRecord {
  jobId: string;
  machineId: string;
  status: z.infer<typeof ProvisioningJobStatusSchema>;
  attempts: number;
  availableAt: string;
  claimedAt: string | null;
  leaseExpiresAt: string | null;
  encryptedPayload: string | null;
  lastErrorCode: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface NewProvisioningJob {
  jobId: string;
  machineId: string;
  encryptedPayload: string;
  availableAt: string;
  createdAt: string;
}

export interface ProvisioningPayload {
  registrationToken: string;
  postgresPassword: string;
}

function mapProvisioningJob(value: unknown): ProvisioningJobRecord {
  const row = ProvisioningJobRowSchema.parse(value);
  return {
    jobId: row.job_id,
    machineId: row.machine_id,
    status: row.status,
    attempts: row.attempts,
    availableAt: row.available_at,
    claimedAt: row.claimed_at,
    leaseExpiresAt: row.lease_expires_at,
    encryptedPayload: row.encrypted_payload,
    lastErrorCode: row.last_error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

function encryptionKey(secret: string): Buffer {
  if (secret.length < 8) {
    throw new Error('Provisioning payload encryption is not configured');
  }
  return createHash('sha256').update(`matrix-provisioning-job:${secret}`).digest();
}

export function sealProvisioningPayload(payload: ProvisioningPayload, secret: string): string {
  const parsed = ProvisioningPayloadSchema.parse(payload);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(secret), iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(parsed), 'utf8'),
    cipher.final(),
  ]);
  const sealed = [
    String(PAYLOAD_VERSION),
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
  if (sealed.length > MAX_ENCRYPTED_PAYLOAD_LENGTH) {
    throw new Error('Provisioning payload exceeds persistence limit');
  }
  return sealed;
}

export function openProvisioningPayload(sealed: string, secret: string): ProvisioningPayload {
  if (sealed.length > MAX_ENCRYPTED_PAYLOAD_LENGTH) {
    throw new Error('Provisioning payload is invalid');
  }
  const [version, ivValue, tagValue, ciphertextValue, ...rest] = sealed.split('.');
  if (version !== String(PAYLOAD_VERSION) || !ivValue || !tagValue || !ciphertextValue || rest.length > 0) {
    throw new Error('Provisioning payload is invalid');
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey(secret), Buffer.from(ivValue, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(ciphertextValue, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
    return ProvisioningPayloadSchema.parse(JSON.parse(plaintext));
  } catch (err: unknown) {
    if (err instanceof Error && err.message === 'Provisioning payload encryption is not configured') {
      throw err;
    }
    throw new Error('Provisioning payload is invalid');
  }
}

export async function insertProvisioningJob(db: PlatformDB, job: NewProvisioningJob): Promise<void> {
  await db.ready;
  await db.executor.insertInto('provisioning_jobs').values({
    job_id: job.jobId,
    machine_id: job.machineId,
    status: 'queued',
    attempts: 0,
    available_at: job.availableAt,
    claimed_at: null,
    lease_expires_at: null,
    encrypted_payload: job.encryptedPayload,
    last_error_code: null,
    created_at: job.createdAt,
    updated_at: job.createdAt,
    completed_at: null,
  }).execute();
}

export async function getProvisioningJobByMachineId(
  db: PlatformDB,
  machineId: string,
): Promise<ProvisioningJobRecord | undefined> {
  await db.ready;
  const row = await db.executor
    .selectFrom('provisioning_jobs')
    .selectAll()
    .where('machine_id', '=', machineId)
    .executeTakeFirst();
  return row ? mapProvisioningJob(row) : undefined;
}

export async function getProvisioningJob(
  db: PlatformDB,
  jobId: string,
): Promise<ProvisioningJobRecord | undefined> {
  await db.ready;
  const row = await db.executor
    .selectFrom('provisioning_jobs')
    .selectAll()
    .where('job_id', '=', jobId)
    .executeTakeFirst();
  return row ? mapProvisioningJob(row) : undefined;
}

export async function listProvisioningJobs(db: PlatformDB, limit: number): Promise<ProvisioningJobRecord[]> {
  await db.ready;
  const boundedLimit = Math.max(1, Math.min(MAX_PROVISIONING_JOBS, Math.trunc(limit)));
  const rows = await db.executor
    .selectFrom('provisioning_jobs')
    .selectAll()
    .orderBy('created_at', 'asc')
    .limit(boundedLimit)
    .execute();
  return rows.map(mapProvisioningJob);
}

export async function listDispatchableProvisioningJobs(
  db: PlatformDB,
  now: string,
  limit: number,
): Promise<ProvisioningJobRecord[]> {
  await db.ready;
  const boundedLimit = Math.max(1, Math.min(MAX_PROVISIONING_JOBS, Math.trunc(limit)));
  const rows = await db.executor
    .selectFrom('provisioning_jobs')
    .selectAll()
    .where((eb) => eb.or([
      eb.and([eb('status', '=', 'queued'), eb('available_at', '<=', now)]),
      eb.and([eb('status', '=', 'running'), eb('lease_expires_at', '<=', now)]),
    ]))
    .orderBy('available_at', 'asc')
    .limit(boundedLimit)
    .execute();
  return rows.map(mapProvisioningJob);
}

export async function claimProvisioningJob(
  db: PlatformDB,
  jobId: string,
  now: string,
  leaseExpiresAt: string,
): Promise<ProvisioningJobRecord | undefined> {
  await db.ready;
  const row = await db.executor
    .updateTable('provisioning_jobs')
    .set((eb) => ({
      status: 'running',
      attempts: eb('attempts', '+', 1),
      claimed_at: now,
      lease_expires_at: leaseExpiresAt,
      updated_at: now,
    }))
    .where('job_id', '=', jobId)
    .where('attempts', '<', MAX_PROVISIONING_JOB_ATTEMPTS)
    .where((eb) => eb.or([
      eb.and([eb('status', '=', 'queued'), eb('available_at', '<=', now)]),
      eb.and([eb('status', '=', 'running'), eb('lease_expires_at', '<=', now)]),
    ]))
    .returningAll()
    .executeTakeFirst();
  return row ? mapProvisioningJob(row) : undefined;
}

export async function completeProvisioningJob(db: PlatformDB, jobId: string, now: string): Promise<boolean> {
  await db.ready;
  const row = await db.executor
    .updateTable('provisioning_jobs')
    .set({
      status: 'completed',
      encrypted_payload: null,
      lease_expires_at: null,
      updated_at: now,
      completed_at: now,
      last_error_code: null,
    })
    .where('job_id', '=', jobId)
    .where('status', '=', 'running')
    .returning('job_id')
    .executeTakeFirst();
  return Boolean(row);
}

export async function failProvisioningJob(
  db: PlatformDB,
  jobId: string,
  now: string,
  errorCode: string,
): Promise<boolean> {
  await db.ready;
  const row = await db.executor
    .updateTable('provisioning_jobs')
    .set({
      status: 'failed',
      encrypted_payload: null,
      lease_expires_at: null,
      updated_at: now,
      completed_at: now,
      last_error_code: errorCode.slice(0, 64),
    })
    .where('job_id', '=', jobId)
    .where('status', '=', 'running')
    .returning('job_id')
    .executeTakeFirst();
  return Boolean(row);
}
