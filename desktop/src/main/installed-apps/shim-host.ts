// The one adapter over Electron 45's experimental app-shim API (spec 2711,
// "Risks"). It starts this channel's shim server on macOS, verifies every
// connecting shim before any window exists (its bundle must be a recorded
// install and its running code must match that bundle's own recorded cdhash,
// which the ad-hoc signature at install made unique), then binds the shim to
// that install's window. Electron is injected, so this is unit-tested on every platform.
import { posix } from "node:path";
import { shimBundleIdentifier, shimCodeRequirement } from "./mac-bundle";
import type { InstalledAppOpenContext, InstalledAppOpenResult } from "./controller";
import type { InstalledAppRecord } from "./record";

// Listeners are only registered here, never called, so any argument list fits.
type Listener = (...args: never[]) => void;

/** The parts of Electron's `AppShimHost` this module uses. */
export interface AppShimLike {
  readonly bundlePath: string;
  readonly bundleId: string;
  isConnected(): boolean;
  satisfiesCodeRequirement(requirement: string): boolean;
  setApplicationMenu(menu: unknown): void;
  quit(): void;
  on(event: string, listener: Listener): unknown;
}

export interface AppShimHostOptions {
  app: {
    startAppShimServer?: (options: { name: string }) => void;
    stopAppShimServer?: () => void;
    on(event: string, listener: Listener): unknown;
    relaunch(): void;
    quit(): void;
  };
  platform: NodeJS.Platform;
  serverName: string;
  records: { list(): Promise<InstalledAppRecord[]> };
  service: {
    open(installId: string, context: InstalledAppOpenContext): Promise<InstalledAppOpenResult>;
    window(installId: string): { on(event: "closed", listener: () => void): unknown } | null;
    saveNow(installId: string): void;
  };
  buildMenu(record: InstalledAppRecord, shim: AppShimLike): unknown;
  /** A link opened with the shim (routed like any Matrix deep link). */
  openUrl(url: string): void;
  /** "Restart Matrix to finish updating"; true for Restart. */
  confirmRestart(): Promise<boolean>;
}

function logFailure(label: string, error: unknown): void {
  console.warn(`[installed-apps] ${label}:`, error instanceof Error ? error.name : "UnknownError");
}

function normalizeBundlePath(path: string): string {
  return posix.normalize(path.normalize("NFC")).replace(/\/+$/, "");
}

type Verdict = { record: InstalledAppRecord } | { reason: string };

/** The trust check: which install a shim is, or why it is refused. */
export function verifyAppShim(shim: AppShimLike, records: readonly InstalledAppRecord[]): Verdict {
  const path = normalizeBundlePath(shim.bundlePath);
  const atPath = records.filter((candidate) => candidate.bundlePath && normalizeBundlePath(candidate.bundlePath) === path);
  if (atPath.length === 0) return { reason: "unknown bundle" };
  // A moved bundle can leave a stale record at a path a newer install now uses: match both.
  const record = atPath.find((candidate) => shim.bundleId === shimBundleIdentifier(candidate.installId));
  if (!record) return { reason: "bundle identifier mismatch" };
  for (const cdHash of record.cdHashes) {
    try {
      if (shim.satisfiesCodeRequirement(shimCodeRequirement(cdHash))) return { record };
    } catch (error: unknown) {
      logFailure("code requirement check failed", error);
    }
  }
  return { reason: "code signature mismatch" };
}

export function createAppShimHost(options: AppShimHostOptions) {
  const { app, service } = options;
  // One connected shim per install; bounded by the install cap and cleared on disconnect.
  const connected = new Map<string, AppShimLike>();
  let running = false;
  let prompting = false;

  const reject = (shim: AppShimLike, reason: string) => {
    console.warn("[installed-apps] rejected an app shim:", reason);
    shim.quit();
  };

  async function openIn(record: InstalledAppRecord, shim: AppShimLike): Promise<void> {
    const { installId } = record;
    let result: InstalledAppOpenResult;
    try {
      result = await service.open(installId, { appShim: shim });
    } catch (error: unknown) {
      logFailure("app shim window failed", error);
      result = "unavailable";
    }
    if (result === "opened") {
      // A shim is one app window: closing it quits the shim, as Cmd+Q does.
      service.window(installId)?.on("closed", () => {
        if (connected.get(installId) === shim && shim.isConnected()) shim.quit();
      });
    } else if (result !== "focused" && shim.isConnected()) {
      shim.quit();
    }
  }

  function bind(record: InstalledAppRecord, shim: AppShimLike): void {
    const { installId } = record;
    connected.set(installId, shim);
    try {
      shim.setApplicationMenu(options.buildMenu(record, shim));
    } catch (error: unknown) {
      logFailure("app shim menu failed", error);
    }
    shim.on("activate", () => { void openIn(record, shim); });
    // The shim closes its windows without `close` events: keep their state now.
    shim.on("quit-requested", () => service.saveNow(installId));
    shim.on("open-url", (_event: unknown, url: unknown) => { if (typeof url === "string") options.openUrl(url); });
    shim.on("disconnected", () => { if (connected.get(installId) === shim) connected.delete(installId); });
    void openIn(record, shim);
  }

  async function accept(shim: AppShimLike): Promise<void> {
    let records: InstalledAppRecord[];
    try {
      records = await options.records.list();
    } catch (error: unknown) {
      logFailure("install records unavailable for an app shim", error);
      shim.quit();
      return;
    }
    const verdict = verifyAppShim(shim, records);
    if ("reason" in verdict) { reject(shim, verdict.reason); return; }
    if (!shim.isConnected()) return;
    const existing = connected.get(verdict.record.installId);
    if (existing && existing !== shim && existing.isConnected()) {
      shim.quit();
      void openIn(verdict.record, existing);
      return;
    }
    bind(verdict.record, shim);
  }

  function versionMismatch(): void {
    if (prompting) return;
    prompting = true;
    void options.confirmRestart()
      .then((restart) => {
        if (!restart) return;
        app.relaunch();
        app.quit();
      })
      .catch((error: unknown) => logFailure("restart prompt failed", error))
      .finally(() => { prompting = false; });
  }

  return {
    /** macOS only, after the app is ready and install records are loaded. False when shims are unavailable. */
    start(): boolean {
      if (running || options.platform !== "darwin" || typeof app.startAppShimServer !== "function") return running;
      app.on("app-shim-connected", (_event: unknown, shim: AppShimLike) => { void accept(shim); });
      app.on("app-shim-version-mismatch", versionMismatch);
      try {
        app.startAppShimServer({ name: options.serverName });
        running = true;
      } catch (error: unknown) {
        // Most often another copy of this channel already serves the name.
        logFailure(`app shim server "${options.serverName}" unavailable`, error);
      }
      return running;
    },

    running: () => running,

    /** Uninstall: the install's shim, if connected, quits with its window. */
    quitShim(installId: string): void {
      const shim = connected.get(installId);
      if (shim?.isConnected()) shim.quit();
    },

    /** Shutdown: no new shims; connected ones close with their windows. */
    stop(): void {
      if (!running || typeof app.stopAppShimServer !== "function") return;
      running = false;
      try {
        app.stopAppShimServer();
      } catch (error: unknown) {
        logFailure("app shim server stop failed", error);
      }
    },
  };
}

export type AppShimHostController = ReturnType<typeof createAppShimHost>;
