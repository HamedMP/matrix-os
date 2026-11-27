// Decides what one installed-app window shows. The app opens only after the
// authenticated catalog still lists it for this runtime and the owner's
// session-token launch succeeds; every other outcome is a generic state page
// (spec 2711 "States"). Real errors are logged here, never shown.
import type { NativeAppOpenRequest, NativeAppOpenTarget } from "../../shared/native-app-open";
import { nativeBrowserProduct } from "../../shared/browser-products";
import type { AppLaunchResult } from "../embeds/app-launch";
import { NativeAppOpenError } from "../embeds/native-app-open";
import type { InstalledAppRecord } from "./record";
import { installedAppAction, type InstalledAppStateKind } from "./state-page";

export type InstalledAppHostState = InstalledAppStateKind | "open";

export interface InstalledAppAuthSnapshot {
  signedIn: boolean;
  runtimeSlot: string;
  authGeneration: number;
}

export interface InstalledAppHostWindow {
  setTitle(title: string): void;
  getContentSize(): [number, number];
  showState(kind: InstalledAppStateKind, appName: string): void;
  close(): void;
  isDestroyed(): boolean;
}

export interface InstalledAppView {
  setBounds(bounds: { x: number; y: number; width: number; height: number }): void;
  attach(): void;
  loadUrl(url: string): Promise<void>;
  destroy(): void;
}

export interface InstalledAppHostOptions {
  record: InstalledAppRecord;
  window: InstalledAppHostWindow;
  getStatus(): InstalledAppAuthSnapshot;
  resolveApp(request: NativeAppOpenRequest): Promise<NativeAppOpenTarget>;
  launch(target: NativeAppOpenTarget): Promise<AppLaunchResult>;
  createView(target: NativeAppOpenTarget, onState: (state: "loading" | "ready" | "failed") => void): Promise<InstalledAppView>;
  focusMain(): void;
}

type Resolution = { kind: "ready"; target: NativeAppOpenTarget } | { kind: InstalledAppStateKind };

function logFailure(label: string, error: unknown): void {
  console.warn(`[installed-apps] ${label}:`, error instanceof Error ? error.name : "UnknownError");
}

async function resolveInstalledApp(options: InstalledAppHostOptions, status: InstalledAppAuthSnapshot): Promise<Resolution> {
  const { record } = options;
  if (!status.signedIn) return { kind: "signed-out" };
  // Installs belong to one Matrix computer; another runtime's catalog must not be consulted.
  if (status.runtimeSlot !== record.runtimeSlot) return { kind: "missing" };
  let target: NativeAppOpenTarget;
  try {
    target = await options.resolveApp({ name: record.name, path: `matrix-app:${record.slug}` });
  } catch (error: unknown) {
    if (error instanceof NativeAppOpenError) {
      if (error.reason === "not-found") return { kind: "missing" };
      if (error.reason === "auth-required") return { kind: "signed-out" };
    }
    logFailure("app catalog check failed", error);
    return { kind: "unavailable" };
  }
  // Browser products need the embedded browser lifecycle; not offered as installed windows yet.
  if (nativeBrowserProduct(target.appIdentity, target.slug)) return { kind: "unavailable" };
  // A different app now owns the slug: never open it under this install's name and icon.
  if (target.appIdentity !== record.appIdentity) return { kind: "missing" };
  return { kind: "ready", target };
}

export function createInstalledAppHost(options: InstalledAppHostOptions) {
  const { record, window } = options;
  let state: InstalledAppHostState = "loading";
  let view: InstalledAppView | null = null;
  let attempt = 0;
  let boundGeneration: number | null = null;
  let disposed = false;

  const contentBounds = () => {
    const [width, height] = window.getContentSize();
    return { x: 0, y: 0, width, height };
  };

  const dropView = () => {
    const current = view;
    view = null;
    current?.destroy();
  };

  const show = (kind: InstalledAppStateKind) => {
    dropView();
    state = kind;
    if (!window.isDestroyed()) window.showState(kind, record.name);
  };

  const isCurrent = (id: number) => !disposed && id === attempt && !window.isDestroyed();

  async function load(): Promise<void> {
    if (disposed) return;
    const id = ++attempt;
    show("loading");
    const status = options.getStatus();
    boundGeneration = status.authGeneration;
    const resolution = await resolveInstalledApp(options, status);
    if (!isCurrent(id)) return;
    if (resolution.kind !== "ready") { show(resolution.kind); return; }
    const { target } = resolution;
    let launch: AppLaunchResult;
    try {
      launch = await options.launch(target);
    } catch (error: unknown) {
      logFailure("app launch failed", error);
      launch = { ok: false, state: "failed" };
    }
    if (!isCurrent(id)) return;
    if (!launch.ok) { show(launch.state === "auth-required" ? "signed-out" : "unavailable"); return; }
    let next: InstalledAppView;
    try {
      next = await options.createView(target, (viewState) => {
        if (view !== next || !isCurrent(id)) return;
        if (viewState === "ready") state = "open";
        if (viewState === "failed") show("unavailable");
      });
    } catch (error: unknown) {
      logFailure("app view failed", error);
      if (isCurrent(id)) show("unavailable");
      return;
    }
    if (!isCurrent(id)) { next.destroy(); return; }
    view = next;
    window.setTitle(target.name);
    next.setBounds(contentBounds());
    next.attach();
    try {
      await next.loadUrl(launch.url);
    } catch (error: unknown) {
      logFailure("app load failed", error);
      if (view === next && isCurrent(id)) show("unavailable");
    }
  }

  return {
    load,
    state: (): InstalledAppHostState => state,

    /** True when `url` is one of the state page's actions (the caller cancels that navigation). */
    handleNavigation(url: string): boolean {
      const action = installedAppAction(url);
      if (!action) return false;
      if (action === "open-matrix") options.focusMain();
      else if (state !== "open" && state !== "loading") void load();
      return true;
    },

    /** Sign-out or runtime switch: an app opened under the old session closes; a state page re-checks. */
    authChanged(status: InstalledAppAuthSnapshot): void {
      if (disposed || status.authGeneration === boundGeneration) return;
      if (state === "open" || view) { window.close(); return; }
      void load();
    },

    resize(): void {
      view?.setBounds(contentBounds());
    },

    dispose(): void {
      disposed = true;
      dropView();
    },
  };
}
