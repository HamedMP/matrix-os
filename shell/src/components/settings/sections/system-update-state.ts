export function parseSemver(value: string): [number, number, number] | null {
  const match = value.match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function normalizeMatrixReleaseTag(tagName: string): string | null {
  if (tagName.startsWith("cli-")) return null;
  const parsed = parseSemver(tagName);
  return parsed ? parsed.join(".") : null;
}

export function isNewer(latest: string, current: string): boolean {
  const a = parseSemver(latest);
  const b = parseSemver(current);
  if (!a || !b) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av > bv) return true;
    if (av < bv) return false;
  }
  return false;
}

export function severityBadgeStyle(severity?: string): string {
  switch (severity) {
    case "security": return "bg-red-500/10 text-red-600";
    case "critical": return "bg-orange-500/10 text-orange-600";
    default: return "bg-blue-500/10 text-blue-600";
  }
}

export function resolveSystemUpdateState(input: {
  installedVersion?: string;
  latestVersion?: string | null;
  updateAvailable?: boolean;
  severity?: string;
  changelog?: string;
  updateType?: string;
}) {
  const updateAvailable = Boolean(input.updateAvailable && input.latestVersion);
  const autoApplying = updateAvailable && (input.severity === "security" || input.updateType === "auto");
  return {
    currentVersion: input.installedVersion ?? "unknown",
    latestVersion: input.latestVersion ?? null,
    updateAvailable,
    autoApplying,
    severity: input.severity,
    changelog: input.changelog,
    showDot: updateAvailable && !autoApplying,
  };
}
