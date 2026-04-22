export interface RateLimitConfig {
  maxAttempts: number;
  windowMs: number;
  lockoutMs: number;
  maxKeys?: number;
}

interface IpRecord {
  attempts: number;
  windowStart: number;
  lockedUntil: number;
}

export interface RateLimiter {
  check(ip: string): boolean;
}

export function createRateLimiter(config: RateLimitConfig): RateLimiter {
  const maxKeys = config.maxKeys ?? 10_000;
  const records = new Map<string, IpRecord>();

  return {
    check(ip: string): boolean {
      const now = Date.now();
      let record = records.get(ip);

      if (record && record.lockedUntil > now) {
        records.delete(ip);
        records.set(ip, record);
        return false;
      }

      if (!record || now - record.windowStart > config.windowMs + config.lockoutMs) {
        record = { attempts: 0, windowStart: now, lockedUntil: 0 };
      }

      if (now - record.windowStart > config.windowMs && record.lockedUntil <= now) {
        record.attempts = 0;
        record.windowStart = now;
        record.lockedUntil = 0;
      }

      record.attempts++;

      if (record.attempts > config.maxAttempts) {
        if (config.lockoutMs > 0 && record.lockedUntil === 0) {
          record.lockedUntil = now + config.lockoutMs;
        }
        records.delete(ip);
        records.set(ip, record);
        if (records.size > maxKeys) {
          const oldest = records.keys().next().value;
          if (oldest !== undefined && oldest !== ip) {
            records.delete(oldest);
          }
        }
        return false;
      }

      records.delete(ip);
      records.set(ip, record);
      if (records.size > maxKeys) {
        const oldest = records.keys().next().value;
        if (oldest !== undefined && oldest !== ip) {
          records.delete(oldest);
        }
      }
      return true;
    },
  };
}
