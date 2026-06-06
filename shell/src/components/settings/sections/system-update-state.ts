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

function parseHostBundleVersion(value: string | undefined): number[] | null {
  if (!value) return null;
  const mainBuild = value.match(/^main-[A-Za-z0-9]+-(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  if (mainBuild) {
    return [
      Number(mainBuild[1]),
      Number(mainBuild[2]),
      Number(mainBuild[3]),
      Number(mainBuild[4]),
      Number(mainBuild[5]),
      Number(mainBuild[6]),
    ];
  }
  // Keep this date-release parser aligned with packages/gateway/src/system-update.ts parseReleaseNumber.
  const match = value.match(/^v?(\d{4})\.(\d{2})\.(\d{2})(?:[-.](\d+))?/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4] ?? 0)];
}

export function compareHostBundleReleaseVersions(candidate: string | undefined, current: string | undefined): number {
  if (!candidate || !current) return 0;
  if (candidate === current) return 0;
  const a = parseHostBundleVersion(candidate);
  const b = parseHostBundleVersion(current);
  if (!a || !b) return 0;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av > bv) return 1;
    if (av < bv) return -1;
  }
  return 0;
}

export function releaseActionLabel(input: {
  candidateVersion?: string;
  currentVersion?: string;
  candidateBuildTime?: string;
  currentBuildTime?: string;
}): "Installed" | "Upgrade" | "Downgrade" | "Install" {
  if (input.candidateVersion && input.candidateVersion === input.currentVersion) return "Installed";
  const versionComparison = compareHostBundleReleaseVersions(input.candidateVersion, input.currentVersion);
  if (versionComparison > 0) return "Upgrade";
  if (versionComparison < 0) return "Downgrade";
  if (input.candidateBuildTime && input.currentBuildTime) {
    const candidateTime = Date.parse(input.candidateBuildTime);
    const currentTime = Date.parse(input.currentBuildTime);
    if (Number.isFinite(candidateTime) && Number.isFinite(currentTime)) {
      if (candidateTime > currentTime) return "Upgrade";
      if (candidateTime < currentTime) return "Downgrade";
    }
  }
  return "Install";
}

export function severityBadgeStyle(severity?: string): string {
  switch (severity) {
    case "security": return "bg-red-500/10 text-red-600";
    case "critical": return "bg-orange-500/10 text-orange-600";
    default: return "bg-blue-500/10 text-blue-600";
  }
}

export function formatReleaseBuildId(gitCommit?: string): string | null {
  if (!gitCommit) return null;
  return `Build ID ${gitCommit.slice(0, 12)}`;
}

export const UPGRADE_INSTALL_STATUS_LINES = [
  "Putting the new version in place. Your files stay where they are.",
  "Almost there. We are making sure everything opens cleanly.",
  "Your workspace is getting the new version ready.",
  "Finishing the install and checking everything responds.",
  "Your workspace is staying put while the update lands.",
  "One last check before the screen refreshes.",
] as const;

export function upgradeInstallStatusLine(index: number): string {
  if (!Number.isInteger(index) || index < 0) return UPGRADE_INSTALL_STATUS_LINES[0];
  return UPGRADE_INSTALL_STATUS_LINES[index % UPGRADE_INSTALL_STATUS_LINES.length];
}

export function resolveUpgradeInstallCopy(input: {
  target?: string | null;
  message?: string | null;
  statusIndex: number;
}) {
  return {
    title: `Installing ${input.target ?? "update"}`,
    detail: input.message ?? "Downloading the update and waiting for your workspace to return.",
    statusLine: upgradeInstallStatusLine(input.statusIndex),
  };
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
