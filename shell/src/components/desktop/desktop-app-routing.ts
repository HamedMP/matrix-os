import type { LayoutWindow } from "@/hooks/useWindowManager";

export const DESKTOP_GATEWAY_FETCH_TIMEOUT_MS = 10_000;

export interface ModuleRegistryEntry {
  name: string;
  type: string;
  path: string;
  status: string;
}

export interface ModuleMeta {
  name: string;
  entry?: string;
  entryPoint?: string;
  icon?: string;
  version?: string;
}

export interface ShellBootstrapIcon {
  url: string;
  etag: string | null;
  versionedUrl: string;
}

export interface ShellBootstrap {
  layout?: { windows?: LayoutWindow[] };
  modules?: ModuleRegistryEntry[];
  apps?: { name: string; path: string; icon?: string; slug?: string }[];
  icons?: Record<string, ShellBootstrapIcon>;
}

function iconAssetPath(iconUrl: string | undefined): string | undefined {
  if (!iconUrl) return undefined;
  try {
    const base = typeof window === "undefined" ? "http://matrix.local" : window.location.origin;
    return new URL(iconUrl, base).pathname;
  } catch (_err: unknown) {
    return iconUrl.split("?")[0];
  }
}

export function sameIconAsset(left: string | undefined, right: string | undefined): boolean {
  return iconAssetPath(left) === iconAssetPath(right);
}

export function gatewayFetchSignal(signal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(DESKTOP_GATEWAY_FETCH_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

export function registryPathToRelativePath(path: string): string | null {
  if (path.startsWith("~/")) {
    return path.slice(2);
  }
  const homePrefix = "/home/matrixos/home/";
  if (path.startsWith(homePrefix)) {
    return path.slice(homePrefix.length);
  }
  return null;
}
