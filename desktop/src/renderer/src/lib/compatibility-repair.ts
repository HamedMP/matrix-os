import { z } from "zod/v4";
import { evaluateRuntimeCompatibility } from "@matrix-os/contracts";
import { DesktopUpdateSnapshotSchema } from "../../../shared/desktop-update";
import type { ApiClient } from "./api";
import { readSystemVersionIdentity, safeSystemVersion } from "./system-version";

const Version = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const CloudCheck = z.object({
  channel: z.enum(["stable", "canary", "beta", "dev"]),
  latest: z.object({ version: Version }).nullable(),
  updateAvailable: z.boolean(),
  error: z.unknown().optional(),
});
export type RepairTarget = "cloud" | "local";
export interface ComponentVersion {
  installed?: string;
  running?: string;
  available?: string;
  state: "current" | "update" | "unavailable" | "preview" | "pending";
}
export interface RepairPlan {
  local: ComponentVersion;
  cloud: ComponentVersion;
  channel?: string;
  compatibilityUpdateRequired: boolean;
  targets: RepairTarget[];
  reason: string;
}
interface Scope {
  api: ApiClient;
  signal: AbortSignal;
  isCurrent: () => boolean;
}
function guard(scope: Scope) {
  scope.signal.throwIfAborted();
  if (!scope.isCurrent()) throw new Error("Computer changed");
}
const options = (signal: AbortSignal) => ({ signal, maxBytes: 64 * 1024, timeoutMs: 10_000 });

export async function loadRepairPlan(scope: Scope & {
  readLocal: () => Promise<{ version: unknown; snapshot: unknown }>;
}): Promise<RepairPlan> {
  guard(scope);
  const [localResult, infoResult, cloudResult] = await Promise.allSettled([
    scope.readLocal(), scope.api.get<unknown>("/api/system/info", options(scope.signal)),
    scope.api.get<unknown>("/api/system/update", options(scope.signal)),
  ]);
  guard(scope);
  const local: ComponentVersion = { state: "unavailable" };
  if (localResult.status === "fulfilled") {
    local.installed = safeSystemVersion(localResult.value.version);
    const parsed = DesktopUpdateSnapshotSchema.safeParse(localResult.value.snapshot);
    if (parsed.success && local.installed) {
      const snapshot = parsed.data;
      if (snapshot.status === "up-to-date") Object.assign(local, { state: "current", available: local.installed });
      else if (snapshot.status === "disabled") local.state = "preview";
      else if ((snapshot.status === "ready" || snapshot.status === "downloading") && snapshot.version) {
        Object.assign(local, { state: "update", available: snapshot.version });
      }
    }
  }
  const info = infoResult.status === "fulfilled" ? infoResult.value : null;
  const identity = readSystemVersionIdentity(info);
  const cloud: ComponentVersion = { installed: identity.installedVersion, running: identity.runningVersion, state: "unavailable" };
  const checked = CloudCheck.safeParse(cloudResult.status === "fulfilled" ? cloudResult.value : null);
  if (checked.success && !checked.data.error && checked.data.latest && cloud.installed) {
    cloud.available = checked.data.latest.version;
    cloud.state = checked.data.updateAvailable && cloud.available !== cloud.installed ? "update" : "current";
  }
  if (cloud.state === "current" && cloud.running && cloud.running !== cloud.installed) cloud.state = "pending";
  const status = evaluateRuntimeCompatibility(info);
  let targets: RepairTarget[] = [];
  let reason: string;
  if (status === "desktop-update-required") {
    targets = local.state === "update" ? ["local"] : [];
    reason = targets.length ? "The cloud computer requires a newer desktop app. We'll update the desktop app."
      : "The cloud computer requires a newer desktop app, but an automatic app update is not available. Check again or install the latest app.";
  } else if (status === "runtime-update-required") {
    targets = cloud.state === "update" ? ["cloud"] : [];
    reason = targets.length ? "Your desktop app requires a newer cloud computer. We'll update the cloud computer."
      : "Your desktop app requires a newer cloud computer, but its update could not be confirmed. Check again.";
  } else {
    if (cloud.state === "update") targets.push("cloud");
    if (local.state === "update") targets.push("local");
    reason = targets.length === 2 ? "Both have newer releases. We'll update the cloud computer first, then the desktop app."
      : targets[0] === "cloud" ? "A newer cloud release is available. We'll update the cloud computer."
      : targets[0] === "local" ? "A newer app release is available. We'll update the desktop app."
      : local.state === "current" && cloud.state === "current" ? "Both are up to date on their current update channels."
      : "Some version checks are unavailable. Check again to confirm what needs updating.";
  }
  if (cloud.installed && cloud.running && cloud.installed !== cloud.running && !targets.length) {
    reason = "The cloud update is installed, but its services are still running the previous version. Check again after the restart completes.";
  }
  return { local, cloud, targets, reason, compatibilityUpdateRequired: status === "desktop-update-required" || status === "runtime-update-required", ...(checked.success ? { channel: checked.data.channel } : {}) };
}

export async function repairVersions(plan: RepairPlan, scope: Scope & {
  checkLocal: () => Promise<unknown>;
  getLocal: () => Promise<unknown>;
  installLocal: () => Promise<{ ok: boolean }>;
  progress: (message: string) => void;
  pause: () => Promise<void>;
}) {
  guard(scope);
  if (plan.targets.includes("cloud") && plan.cloud.available) {
    scope.progress("Updating cloud computer… The connection may briefly restart.");
    guard(scope);
    await scope.api.post("/api/system/update", { version: plan.cloud.available }, options(scope.signal));
    // An accepted request or a replaced release.json is not running-service proof.
    const deadline = Date.now() + 10 * 60_000;
    for (;;) {
      guard(scope);
      try {
        const info = await scope.api.get<unknown>("/api/system/info", options(scope.signal));
        guard(scope);
        const current = readSystemVersionIdentity(info);
        if (current.installedVersion === plan.cloud.available && current.runningVersion === plan.cloud.available) break;
      } catch (error: unknown) {
        guard(scope);
        console.warn("[compatibility-repair] waiting for cloud services:", error instanceof Error ? error.name : "UnknownError");
      }
      if (Date.now() >= deadline) throw new Error("Cloud update is still pending");
      await scope.pause();
    }
  }
  if (plan.targets.includes("local")) {
    scope.progress("Updating desktop app… It will restart when the download is ready.");
    guard(scope);
    let snapshot = DesktopUpdateSnapshotSchema.parse(await scope.checkLocal());
    const deadline = Date.now() + 30 * 60_000;
    let attempts = 0;
    for (;;) {
      guard(scope);
      if (snapshot.status === "up-to-date") break;
      if (snapshot.status === "error" || snapshot.status === "disabled") throw new Error("Local update unavailable");
      if (snapshot.status === "ready") {
        if (++attempts > 3) throw new Error("Local update could not be installed");
        guard(scope);
        if ((await scope.installLocal()).ok) return;
      }
      if (Date.now() >= deadline) throw new Error("Local download is still pending");
      await scope.pause();
      guard(scope);
      snapshot = DesktopUpdateSnapshotSchema.parse(await scope.getLocal());
    }
  }
  scope.progress("Updates complete. Your versions have been checked.");
}
