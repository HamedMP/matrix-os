import { randomBytes } from 'node:crypto';
import { eq, lt } from 'drizzle-orm';
import type { PlatformDB } from './db.js';
import { deviceCodes } from './schema.js';

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
  const now = config.now ?? (() => Date.now());
  const random = config.random ?? ((n: number) => randomBytes(n));
  const issueToken =
    config.issueToken ??
    (() => {
      throw new Error(
        'createDeviceFlow: issueToken not configured -- cannot approve device codes',
      );
    });

  function gcExpired(threshold: number): void {
    config.db.delete(deviceCodes).where(lt(deviceCodes.expiresAt, threshold)).run();
  }

  return {
    async createDeviceCode(): Promise<DeviceCodeIssue> {
      const ts = now();
      gcExpired(ts);

      // Retry on user_code collision (extremely rare but possible).
      for (let attempt = 0; attempt < 5; attempt++) {
        const userCodeRaw = generateUserCode(random);
        const deviceCode = generateDeviceCode(random);
        try {
          config.db
            .insert(deviceCodes)
            .values({
              deviceCode,
              userCode: userCodeRaw,
              clerkUserId: null,
              expiresAt: ts + expiresInSec * 1000,
              lastPolledAt: null,
              createdAt: ts,
            })
            .run();

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
      const row = config.db
        .select()
        .from(deviceCodes)
        .where(eq(deviceCodes.deviceCode, deviceCode))
        .get();

      if (!row || row.expiresAt < ts) {
        if (row) {
          config.db
            .delete(deviceCodes)
            .where(eq(deviceCodes.deviceCode, deviceCode))
            .run();
        }
        return { status: 'expired' };
      }

      // Slow-down enforcement: reject polls within `intervalSec` of the last
      // one. Per RFC 8628 §3.5, the client MUST then increase its interval.
      if (row.lastPolledAt && ts - row.lastPolledAt < intervalSec * 1000) {
        return { status: 'slow_down' };
      }

      config.db
        .update(deviceCodes)
        .set({ lastPolledAt: ts })
        .where(eq(deviceCodes.deviceCode, deviceCode))
        .run();

      if (!row.clerkUserId) {
        return { status: 'pending' };
      }

      const issued = await issueToken({ clerkUserId: row.clerkUserId });

      // Single-use: delete the row so a second poll can't replay the JWT.
      config.db
        .delete(deviceCodes)
        .where(eq(deviceCodes.deviceCode, deviceCode))
        .run();

      return {
        status: 'approved',
        token: issued.token,
        expiresAt: issued.expiresAt,
        handle: issued.handle,
        clerkUserId: row.clerkUserId,
      };
    },

    async approveDeviceCode(userCode: string, clerkUserId: string): Promise<void> {
      const ts = now();
      const normalized = normalizeUserCode(userCode);

      const row = config.db
        .select()
        .from(deviceCodes)
        .where(eq(deviceCodes.userCode, normalized))
        .get();

      if (!row) {
        throw new Error('Unknown user_code');
      }
      if (row.expiresAt < ts) {
        config.db
          .delete(deviceCodes)
          .where(eq(deviceCodes.userCode, normalized))
          .run();
        throw new Error('Expired user_code');
      }

      config.db
        .update(deviceCodes)
        .set({ clerkUserId })
        .where(eq(deviceCodes.userCode, normalized))
        .run();
    },
  };
}
