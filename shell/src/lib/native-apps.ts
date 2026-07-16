export const NATIVE_APP_PATH_PREFIX = "native:";
export const SAFE_NATIVE_APP_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface NativeAppSummary {
  id: string;
  name: string;
  runtime: "linux-native";
  enabled: boolean;
}

export function isNativeAppPath(path: string): boolean {
  return path.startsWith(NATIVE_APP_PATH_PREFIX) && SAFE_NATIVE_APP_ID.test(path.slice(NATIVE_APP_PATH_PREFIX.length));
}

export function nativeAppIdFromPath(path: string): string | null {
  if (!path.startsWith(NATIVE_APP_PATH_PREFIX)) return null;
  const appId = path.slice(NATIVE_APP_PATH_PREFIX.length);
  return SAFE_NATIVE_APP_ID.test(appId) ? appId : null;
}
