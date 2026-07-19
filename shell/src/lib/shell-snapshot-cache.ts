"use client";

import { DEFAULT_PINNED_APPS } from "@/lib/builtin-apps";
import type { Theme } from "@/hooks/useTheme";
import type { DesktopConfig } from "@/hooks/useDesktopConfig";

export const SHELL_SNAPSHOT_STORAGE_PREFIX = "matrix:shell-snapshot:v1";
const SHELL_SNAPSHOT_VERSION = 1;
const MAX_SNAPSHOT_BYTES = 128_000;
const MAX_SNAPSHOT_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const SAFE_SLUG = /^[A-Za-z0-9_-]{1,64}$/;
const SAFE_APP_PATH = /^(?:apps\/[A-Za-z0-9._~/-]{1,240}|__[-A-Za-z0-9_]+__)(?::[-A-Za-z0-9_]+)?$/;

export interface ShellSnapshotScope {
  userId: string;
  runtimeScope: string;
  storageKey: string;
}

export interface ShellBootstrapIconSnapshot {
  url: string;
  etag: string | null;
  versionedUrl: string;
}

export interface ShellBootstrapSnapshot {
  layout?: { windows?: unknown[] };
  modules?: unknown[];
  apps?: { name: string; path: string; icon?: string; slug?: string }[];
  icons?: Record<string, ShellBootstrapIconSnapshot>;
}

export interface ShellSnapshot {
  theme?: Theme;
  desktopConfig?: DesktopConfig;
  bootstrap?: ShellBootstrapSnapshot;
}

interface StoredShellSnapshot {
  version: number;
  updatedAt: number;
  data: unknown;
}

let lastScope:
  | { userId: string; runtimeScope: string; value: ShellSnapshotScope }
  | null = null;

export function createShellSnapshotScope({
  userId,
  pathname,
}: {
  userId: string | null | undefined;
  pathname?: string | null;
}): ShellSnapshotScope | null {
  const normalizedUserId = typeof userId === "string" ? userId.trim() : "";
  if (!normalizedUserId || normalizedUserId.length > 256 || !/^[A-Za-z0-9_-]+$/.test(normalizedUserId)) {
    return null;
  }
  const runtimeScope = runtimeScopeFromPath(pathname ?? browserPathname());
  if (lastScope?.userId === normalizedUserId && lastScope.runtimeScope === runtimeScope) {
    return lastScope.value;
  }
  const value = {
    userId: normalizedUserId,
    runtimeScope,
    storageKey: `${SHELL_SNAPSHOT_STORAGE_PREFIX}:${encodeURIComponent(normalizedUserId)}:${encodeURIComponent(runtimeScope)}`,
  };
  lastScope = { userId: normalizedUserId, runtimeScope, value };
  return value;
}

export function loadShellSnapshot(
  scope: ShellSnapshotScope | null | undefined,
  storage: Storage | null = browserStorage(),
): ShellSnapshot | null {
  if (!scope || !storage) return null;
  try {
    const raw = storage.getItem(scope.storageKey);
    if (!raw || raw.length > MAX_SNAPSHOT_BYTES) return null;
    const stored = JSON.parse(raw) as StoredShellSnapshot;
    if (!isRecord(stored) || stored.version !== SHELL_SNAPSHOT_VERSION || typeof stored.updatedAt !== "number") {
      return null;
    }
    if (Date.now() - stored.updatedAt > MAX_SNAPSHOT_AGE_MS) return null;
    return normalizeShellSnapshot(stored.data);
  } catch (err: unknown) {
    console.warn("[shell-cache] failed to load shell snapshot", err instanceof Error ? err.name : typeof err);
    return null;
  }
}

export function saveShellSnapshot(
  scope: ShellSnapshotScope | null | undefined,
  patch: ShellSnapshot,
  storage: Storage | null = browserStorage(),
): boolean {
  if (!scope || !storage) return false;
  const current = loadShellSnapshot(scope, storage) ?? {};
  const next = normalizeShellSnapshot({ ...current, ...patch });
  const raw = JSON.stringify({
    version: SHELL_SNAPSHOT_VERSION,
    updatedAt: Date.now(),
    data: next,
  });
  if (raw.length > MAX_SNAPSHOT_BYTES) return false;
  try {
    storage.setItem(scope.storageKey, raw);
    return true;
  } catch (err: unknown) {
    console.warn("[shell-cache] failed to save shell snapshot", err instanceof Error ? err.name : typeof err);
    return false;
  }
}

export function clearShellSnapshot(
  scope: ShellSnapshotScope | null | undefined,
  storage: Storage | null = browserStorage(),
): void {
  if (!scope || !storage) return;
  storage.removeItem(scope.storageKey);
}

export function normalizeShellSnapshot(value: unknown): ShellSnapshot {
  if (!isRecord(value)) return {};
  return {
    ...(value.theme !== undefined ? { theme: normalizeThemeSnapshot(value.theme) } : {}),
    ...(value.desktopConfig !== undefined ? { desktopConfig: normalizeDesktopConfigSnapshot(value.desktopConfig) } : {}),
    ...(value.bootstrap !== undefined ? { bootstrap: normalizeBootstrapSnapshot(value.bootstrap) } : {}),
  };
}

function normalizeThemeSnapshot(value: unknown): Theme | undefined {
  if (!isRecord(value) || !isRecord(value.colors) || !isRecord(value.fonts)) return undefined;
  const colors = stringRecord(value.colors, 80);
  const fonts = stringRecord(value.fonts, 40);
  if (Object.keys(colors).length === 0 || Object.keys(fonts).length === 0) return undefined;
  return {
    name: safeString(value.name, 80) ?? "cached",
    ...(value.mode === "light" || value.mode === "dark" ? { mode: value.mode } : {}),
    ...(value.style === "flat" ||
      value.style === "neumorphic" ||
      value.style === "macos-glass" ||
      value.style === "winxp" ||
      value.style === "win11"
      ? { style: value.style }
      : {}),
    colors,
    fonts,
    radius: safeString(value.radius, 32) ?? "0.75rem",
  };
}

function normalizeDesktopConfigSnapshot(value: unknown): DesktopConfig | undefined {
  if (!isRecord(value)) return undefined;
  const dock = normalizeDock(value.dock);
  return {
    background: normalizeBackground(value.background),
    dock,
    pinnedApps: normalizeAppPaths(value.pinnedApps, DEFAULT_PINNED_APPS),
    ...(typeof value.iconStyle === "string" && value.iconStyle.length <= 240 ? { iconStyle: value.iconStyle } : {}),
    ...(isRecord(value.dockOrder)
      ? {
          dockOrder: {
            userApps: normalizeAppPaths(value.dockOrder.userApps, []),
            systemApps: normalizeAppPaths(value.dockOrder.systemApps, []),
          },
        }
      : {}),
  };
}

function normalizeBootstrapSnapshot(value: unknown): ShellBootstrapSnapshot | undefined {
  if (!isRecord(value)) return undefined;
  return {
    layout: normalizeBootstrapLayout(value.layout),
    modules: Array.isArray(value.modules) ? value.modules.filter(isRecord).slice(0, 200) : [],
    apps: normalizeBootstrapApps(value.apps),
    icons: normalizeBootstrapIcons(value.icons),
  };
}

function normalizeBootstrapLayout(value: unknown): { windows?: unknown[] } {
  if (!isRecord(value) || !Array.isArray(value.windows)) return {};
  return { windows: value.windows.filter(isRecord).slice(0, 100) };
}

function normalizeBootstrapApps(value: unknown): ShellBootstrapSnapshot["apps"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const name = safeString(entry.name, 120);
    const path = safeBootstrapAppPath(entry.path);
    if (!name || !path) return [];
    const icon = safeSlug(entry.icon);
    const slug = safeSlug(entry.slug);
    return [{ name, path, icon, slug }];
  }).slice(0, 200);
}

function normalizeBootstrapIcons(value: unknown): Record<string, ShellBootstrapIconSnapshot> {
  if (!isRecord(value)) return {};
  const icons: Record<string, ShellBootstrapIconSnapshot> = {};
  for (const [slug, icon] of Object.entries(value)) {
    if (!SAFE_SLUG.test(slug) || !isRecord(icon)) continue;
    const url = safeStaticPath(icon.url, "/icons/");
    const versionedUrl = safeStaticPath(icon.versionedUrl, "/icons/");
    if (!url || !versionedUrl) continue;
    icons[slug] = {
      url,
      etag: typeof icon.etag === "string" && icon.etag.length <= 120 ? icon.etag : null,
      versionedUrl,
    };
  }
  return icons;
}

function normalizeDock(value: unknown): DesktopConfig["dock"] {
  const fallback: DesktopConfig["dock"] = { position: "left", size: 56, iconSize: 40, autoHide: false };
  if (!isRecord(value)) return fallback;
  if (value.position !== "left" && value.position !== "bottom") return fallback;
  if (!isBoundedNumber(value.size, 32, 96) || !isBoundedNumber(value.iconSize, 24, 72)) return fallback;
  return {
    position: value.position,
    size: value.size,
    iconSize: value.iconSize,
    autoHide: false,
  };
}

function normalizeBackground(value: unknown): DesktopConfig["background"] {
  const fallback: DesktopConfig["background"] = { type: "wallpaper", name: "moraine-lake.jpg" };
  if (!isRecord(value) || typeof value.type !== "string") return fallback;
  if (value.type === "pattern") return { type: "pattern" };
  if (value.type === "solid" && safeCssColor(value.color)) return { type: "solid", color: value.color };
  if (value.type === "gradient" && safeCssColor(value.from) && safeCssColor(value.to)) {
    return {
      type: "gradient",
      from: value.from,
      to: value.to,
      ...(isBoundedNumber(value.angle, 0, 360) ? { angle: value.angle } : {}),
    };
  }
  if (value.type === "wallpaper") {
    const name = safeFileName(value.name);
    return name ? { type: "wallpaper", name } : fallback;
  }
  if (value.type === "image") {
    const url = safeImageUrl(value.url);
    return url ? { type: "image", url, fit: safeString(value.fit, 24) ?? "cover" } : fallback;
  }
  return fallback;
}

function normalizeAppPaths(value: unknown, fallback: readonly string[]): string[] {
  if (!Array.isArray(value)) return [...fallback];
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const path = item.trim();
    if (!SAFE_APP_PATH.test(path) || path.includes("..") || seen.has(path)) continue;
    seen.add(path);
    paths.push(path);
  }
  return paths.slice(0, 120);
}

function runtimeScopeFromPath(pathname: string | null | undefined): string {
  const match = (pathname ?? "").match(/^\/vm\/([A-Za-z0-9_-]{1,64})(?:\/|$)/);
  return match ? `/vm/${match[1]}` : "default";
}

function browserPathname(): string {
  return typeof window === "undefined" ? "/" : window.location.pathname;
}

function browserStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  return window.localStorage;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringRecord(value: Record<string, unknown>, maxEntries: number): Record<string, string> {
  return Object.fromEntries(
    Object.entries(value)
      .filter((entry): entry is [string, string] => SAFE_SLUG.test(entry[0]) && typeof entry[1] === "string" && entry[1].length <= 240)
      .slice(0, maxEntries),
  );
}

function safeString(value: unknown, maxLength: number): string | undefined {
  return typeof value === "string" && value.trim() && value.length <= maxLength ? value : undefined;
}

function safeSlug(value: unknown): string | undefined {
  return typeof value === "string" && SAFE_SLUG.test(value) ? value : undefined;
}

function safeBootstrapAppPath(value: unknown): string | undefined {
  if (typeof value !== "string" || value.includes("..") || value.length > 260) return undefined;
  return value.startsWith("/files/apps/") || value.startsWith("apps/") || value.startsWith("__") ? value : undefined;
}

function safeStaticPath(value: unknown, prefix: string): string | undefined {
  if (typeof value !== "string" || value.length > 300) return undefined;
  if (!value.startsWith(prefix) || value.includes("..") || value.includes("javascript:")) return undefined;
  return value;
}

function safeFileName(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9._-]{1,160}$/.test(value) ? value : undefined;
}

function safeCssColor(value: unknown): value is string {
  return typeof value === "string" && value.length <= 80 && !/[;<>{}]/.test(value);
}

function safeImageUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 500 || /javascript:/i.test(value)) return undefined;
  try {
    const url = new URL(value, typeof window === "undefined" ? "https://app.matrix-os.com" : window.location.origin);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    if (url.origin === (typeof window === "undefined" ? "https://app.matrix-os.com" : window.location.origin)) {
      return `${url.pathname}${url.search}`;
    }
    return url.toString();
  } catch (err: unknown) {
    if (!(err instanceof TypeError)) {
      console.warn("[shell-snapshot-cache] unexpected image URL parse failure:", err);
    }
    return undefined;
  }
}

function isBoundedNumber(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}
