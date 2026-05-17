import { MESSAGING_SETUP_SESSION_TTL_MS } from "./constants.js";

export function createSetupExpiresAt(nowMs = Date.now()): string {
  return new Date(nowMs + MESSAGING_SETUP_SESSION_TTL_MS).toISOString();
}

export function isSetupExpired(expiresAt: Date | string, nowMs = Date.now()): boolean {
  return new Date(expiresAt).getTime() <= nowMs;
}
