export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.modify";
export interface NativeGmailBinding { externalUserId: string; accountId: string }
export interface NativeGmailConnection {
  userId: string; externalUserId: string; connectionId: string; accountId: string;
  status: "active" | "expired" | "revoked";
  accountLabel: string; email: string; encryptedCredentials: string; revision: number;
}
export interface NativeGmailState {
  hash: string; userId: string; externalUserId: string; encryptedVerifier: string;
  label: string; redirectUri?: string; expiresAt: Date;
}
export interface NativeGmailLease extends NativeGmailConnection { leaseId: string }
export interface NativeGmailCredentials {
  clientId: string; accessToken: string; refreshToken: string; expiresAt: number; scope: string;
}
export interface NativeGmailStore {
  migrate(): Promise<void>;
  acquireOwnerLease(userId: string, now: Date): Promise<string | null>;
  releaseOwnerLease(userId: string, leaseId: string): Promise<void>;
  startState(input: NativeGmailState & { now: Date }): Promise<void>;
  inspectState(hash: string, now: Date): Promise<NativeGmailState | null>;
  consumeState(hash: string, now: Date): Promise<NativeGmailState | null>;
  connect(input: { userId: string; externalUserId: string; email: string; label?: string; scopes: string[];
    encrypt: (accountId: string) => string; now: Date; ownerLease?: string }): Promise<NativeGmailConnection>;
  lookup(binding: NativeGmailBinding, now?: Date): Promise<NativeGmailConnection | null>;
  refreshPending(binding: NativeGmailBinding, now: Date): Promise<boolean>;
  byConnection(binding: { userId: string; connectionId: string }): Promise<NativeGmailConnection | null>;
  acquireLease(row: NativeGmailConnection, now: Date, operation?: "refresh" | "revoke"): Promise<NativeGmailLease | null>;
  settle(lease: NativeGmailLease, encrypted: string, status: "active" | "expired", now: Date): Promise<boolean>;
  releaseLease(lease: NativeGmailLease): Promise<void>;
  remove(lease: NativeGmailLease, now: Date): Promise<boolean>;
  assertCurrent(row: NativeGmailConnection, now?: Date): Promise<boolean>;
}
