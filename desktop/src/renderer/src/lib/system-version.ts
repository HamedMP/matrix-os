const SAFE_SYSTEM_VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface SystemVersionIdentity {
  installedVersion?: string;
  runningVersion?: string;
}

export function readSystemVersionIdentity(value: unknown): SystemVersionIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const info = value as {
    version?: unknown;
    runningVersion?: unknown;
    release?: { version?: unknown };
  };
  return {
    installedVersion: safeSystemVersion(info.release?.version) ?? safeSystemVersion(info.version),
    runningVersion: safeSystemVersion(info.runningVersion),
  };
}

export function safeSystemVersion(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return SAFE_SYSTEM_VERSION.test(trimmed) ? trimmed : undefined;
}
