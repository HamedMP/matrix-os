import { randomBytes } from 'node:crypto';
import type { PlatformDB } from './db.js';

// RFC 8628 §6.1 example alphabet: 20-char consonants only.
// Excludes vowels (no offensive accidental words) and visually
// ambiguous characters (no I/O/0/1/L). Generates a code that's
// safe to display in a verification URL.
export const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';
const USER_CODE_LENGTH = 8;
const DEVICE_CODE_BYTES = 32;

export interface DeviceCodeIssue {
  deviceCode: string;
  userCode: string; // dashed: XXXX-XXXX
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

export interface IssuedToken {
  token: string;
  expiresAt: number; // epoch ms
  handle: string;
}

export interface IssueTokenInput {
  clerkUserId: string;
}

export type DevicePollResult =
  | { status: 'pending' }
  | { status: 'slow_down' }
  | { status: 'expired' }
  | { status: 'approved'; token: string; expiresAt: number; handle: string; clerkUserId: string };

export interface DeviceFlowConfig {
  db: PlatformDB;
  verificationBase: string;
  expiresInSec?: number; // default 900
  intervalSec?: number; // default 5
  maxInFlightPolls?: number; // default 1024
  issueTokenTimeoutMs?: number; // default 30000
  now?: () => number;
  random?: (bytes: number) => Buffer;
  issueToken?: (input: IssueTokenInput) => Promise<IssuedToken>;
}

export interface DeviceFlow {
  createDeviceCode(): Promise<DeviceCodeIssue>;
  pollDeviceCode(deviceCode: string): Promise<DevicePollResult>;
  approveDeviceCode(userCode: string, clerkUserId: string): Promise<void>;
}

export function formatUserCode(raw: string): string {
  if (raw.length !== USER_CODE_LENGTH) {
    return raw;
  }
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

export function normalizeUserCode(input: string): string {
  return input.replace(/[\s-]/g, '').toUpperCase();
}

function generateUserCode(random: (bytes: number) => Buffer): string {
  // Rejection sampling so the alphabet's bias is uniform. 20 chars fit in
  // 5 bits with bias; we sample a byte and discard >= 200 (10 * 20) to keep
  // the per-character distribution flat.
  const out: string[] = [];
  while (out.length < USER_CODE_LENGTH) {
    const buf = random(USER_CODE_LENGTH * 2);
    for (const byte of buf) {
      if (byte >= 200) continue;
      out.push(USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length]);
      if (out.length === USER_CODE_LENGTH) break;
    }
  }
  return out.join('');
}

function generateDeviceCode(random: (bytes: number) => Buffer): string {
  return random(DEVICE_CODE_BYTES).toString('base64url');
}

export function createDeviceFlow(config: DeviceFlowConfig): DeviceFlow {
  const expiresInSec = config.expiresInSec ?? 900;
  const intervalSec = config.intervalSec ?? 5;
  const maxInFlightPolls = Math.max(1, config.maxInFlightPolls ?? 1024);
  const issueTokenTimeoutMs = Math.max(1, config.issueTokenTimeoutMs ?? 30_000);
  const now = config.now ?? (() => Date.now());
  const random = config.random ?? ((n: number) => randomBytes(n));
  const inFlightPolls = new Map<string, Promise<DevicePollResult>>();
  const issueToken =
    config.issueToken ??
    (() => {
      throw new Error(
        'createDeviceFlow: issueToken not configured -- cannot approve device codes',
      );
    });

  async function gcExpired(threshold: number): Promise<void> {
    await config.db.ready;
    await config.db.executor
      .deleteFrom('device_codes')
      .where('expires_at', '<', threshold)
      .execute();
  }

  return {
    async createDeviceCode(): Promise<DeviceCodeIssue> {
      const ts = now();
      await gcExpired(ts);

      // Retry on user_code collision (extremely rare but possible).
      for (let attempt = 0; attempt < 5; attempt++) {
        const userCodeRaw = generateUserCode(random);
        const deviceCode = generateDeviceCode(random);
        try {
          await config.db.executor
            .insertInto('device_codes')
            .values({
              device_code: deviceCode,
              user_code: userCodeRaw,
              clerk_user_id: null,
              expires_at: ts + expiresInSec * 1000,
              last_polled_at: null,
              created_at: ts,
            })
            .execute();

          const userCode = formatUserCode(userCodeRaw);
          return {
            deviceCode,
            userCode,
            verificationUri: `${config.verificationBase}/auth/device?user_code=${userCode}`,
            expiresIn: expiresInSec,
            interval: intervalSec,
          };
        } catch (err) {
          if (
            err instanceof Error &&
            /UNIQUE/i.test(err.message) &&
            attempt < 4
          ) {
            continue;
          }
          throw err;
        }
      }
      throw new Error('Failed to allocate unique user_code after 5 attempts');
    },

    async pollDeviceCode(deviceCode: string): Promise<DevicePollResult> {
      const ts = now();
      const existingPoll = inFlightPolls.get(deviceCode);
      if (existingPoll) {
        return existingPoll;
      }
      let resolveIssue!: (value: DevicePollResult) => void;
      let rejectIssue!: (reason?: unknown) => void;
      const issuePromise = new Promise<DevicePollResult>((resolve, reject) => {
        resolveIssue = resolve;
        rejectIssue = reject;
      });
      inFlightPolls.set(deviceCode, issuePromise);

      const claimed = await config.db.transaction(async (trx) => {
        const row = await trx.executor
          .selectFrom('device_codes')
          .selectAll()
          .where('device_code', '=', deviceCode)
          .executeTakeFirst();

        if (!row || row.expires_at < ts) {
          if (row) {
            await trx.executor
              .deleteFrom('device_codes')
              .where('device_code', '=', deviceCode)
              .execute();
          }
          return { status: 'expired' } as DevicePollResult;
        }

        if (row.last_polled_at && ts - row.last_polled_at < intervalSec * 1000) {
          return { status: 'slow_down' } as DevicePollResult;
        }

        if (!row.clerk_user_id) {
          await trx.executor
            .updateTable('device_codes')
            .set({ last_polled_at: ts })
            .where('device_code', '=', deviceCode)
            .execute();
          return { status: 'pending' } as DevicePollResult;
        }

        return {
          status: 'approved',
          clerkUserId: row.clerk_user_id,
        } as const;
      });

      if (claimed.status !== 'approved') {
        resolveIssue(claimed);
        if (inFlightPolls.get(deviceCode) === issuePromise) {
          inFlightPolls.delete(deviceCode);
        }
        return issuePromise;
      }

      // Fail closed when the dedupe map is saturated. Evicting another
      // approved device code's in-flight promise would allow a later poll
      // for that code to issue a duplicate token.
      if (inFlightPolls.size > maxInFlightPolls) {
        const result = { status: 'slow_down' } as const;
        resolveIssue(result);
        if (inFlightPolls.get(deviceCode) === issuePromise) {
          inFlightPolls.delete(deviceCode);
        }
        return issuePromise;
      }

      void (async () => {
        try {
          const consumeResult = await config.db.transaction(async (trx) => {
            const row = await trx.executor
              .selectFrom('device_codes')
              .selectAll()
              .where('device_code', '=', deviceCode)
              .executeTakeFirst();

            if (!row || row.expires_at < ts) {
              if (row) {
                await trx.executor
                  .deleteFrom('device_codes')
                  .where('device_code', '=', deviceCode)
                  .execute();
              }
              return { status: 'expired' } as DevicePollResult;
            }

            if (row.clerk_user_id !== claimed.clerkUserId) {
              return { status: 'expired' } as DevicePollResult;
            }

            await trx.executor
              .deleteFrom('device_codes')
              .where('device_code', '=', deviceCode)
              .execute();

            return null;
          });

          if (consumeResult) {
            resolveIssue(consumeResult);
            return;
          }

          const issued = await new Promise<IssuedToken>((resolve, reject) => {
            const timer = setTimeout(() => {
              reject(new Error('issueToken timeout'));
            }, issueTokenTimeoutMs);
            void issueToken({ clerkUserId: claimed.clerkUserId }).then(
              (value) => {
                clearTimeout(timer);
                resolve(value);
              },
              (err: unknown) => {
                clearTimeout(timer);
                reject(err);
              },
            );
          });

          resolveIssue({
            status: 'approved',
            token: issued.token,
            expiresAt: issued.expiresAt,
            handle: issued.handle,
            clerkUserId: claimed.clerkUserId,
          });
        } catch (err: unknown) {
          rejectIssue(err);
        } finally {
          if (inFlightPolls.get(deviceCode) === issuePromise) {
            inFlightPolls.delete(deviceCode);
          }
        }
      })();
      return issuePromise;
    },

    async approveDeviceCode(userCode: string, clerkUserId: string): Promise<void> {
      const ts = now();
      const normalized = normalizeUserCode(userCode);
      await config.db.transaction(async (trx) => {
        const row = await trx.executor
          .selectFrom('device_codes')
          .selectAll()
          .where('user_code', '=', normalized)
          .executeTakeFirst();

        if (!row) {
          throw new Error('Unknown user_code');
        }
        if (row.expires_at < ts) {
          await trx.executor
            .deleteFrom('device_codes')
            .where('user_code', '=', normalized)
            .execute();
          throw new Error('Expired user_code');
        }
        if (row.clerk_user_id && row.clerk_user_id !== clerkUserId) {
          throw new Error('Device code already approved');
        }

        await trx.executor
          .updateTable('device_codes')
          .set({ clerk_user_id: clerkUserId })
          .where('user_code', '=', normalized)
          .execute();
      });
    },
  };
}
