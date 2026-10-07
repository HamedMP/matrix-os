import type { Transaction } from 'kysely';
import type { PlatformDatabase } from '../db.js';
export const ACCOUNT_DELETION_GRACE_MS = 5 * 24 * 60 * 60 * 1000;
export const ACCOUNT_DELETION_STEPS = ['billing', 'vps', 'integrations', 'apple', 'storage', 'data', 'clerk'] as const;
export type AccountDeletionStep = typeof ACCOUNT_DELETION_STEPS[number];
export interface AppleDeletionToken { clientId: string; token: string; tokenType: 'access_token' | 'refresh_token'; }
export interface AccountDeletionContext {
  clerkUserId: string;
  appleTokens: AppleDeletionToken[];
  appleRevocationUnknown?: boolean;
  appleRevocationPrepared?: boolean;
  manualAppleRevocationRequired?: boolean;
}
export interface AccountDeletionAdapters {
  prepare(clerkUserId: string, identityDeleted?: boolean, transaction?: Transaction<PlatformDatabase>): Promise<AccountDeletionContext>;
  prepareAppleRevocation?(context: AccountDeletionContext): Promise<AccountDeletionContext>;
  billing(context: AccountDeletionContext): Promise<void>;
  vps(context: AccountDeletionContext): Promise<void>;
  integrations(context: AccountDeletionContext): Promise<void>;
  apple(context: AccountDeletionContext): Promise<void>;
  storage(context: AccountDeletionContext): Promise<void>;
  data(context: AccountDeletionContext): Promise<void>;
  clerk(context: AccountDeletionContext): Promise<void>;
}
export interface AccountDeletionStatus {
  status: 'scheduled' | 'processing' | 'completed' | 'cancelled' | 'none';
  erasesAfter?: string | null;
  /** Completion target; provider retries can extend it. */
  completesBy: string | null;
  billingStopped: boolean;
  /** Remove Apple authorization manually when a verifiable revocation grant is unavailable. */
  manualAppleRevocationRequired?: boolean;
}
export interface AccountDeletionService {
  schedule(clerkUserId: string, identityDeleted?: boolean): Promise<AccountDeletionStatus>;
  get(clerkUserId: string): Promise<AccountDeletionStatus>;
  cancel(clerkUserId: string): Promise<AccountDeletionStatus>;
  reconcile(): Promise<void>;
  isBlocked(clerkUserId: string): Promise<boolean>;
}
export class AccountDeletionOwnershipError extends Error {
  constructor() { super('ownership_transfer_required'); this.name = 'AccountDeletionOwnershipError'; }
}
