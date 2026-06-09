const MAX_PLATFORM_HEADER_LENGTH = 512;

type PlatformSessionHeaders = Pick<Headers, "get">;

export const MATRIX_NATIVE_APP_SESSION_HEADER = "x-matrix-native-app-session";
export const MATRIX_PLATFORM_SESSION_HEADER = "x-matrix-platform-session";

export function hasServerVerifiedMatrixSession(headers: PlatformSessionHeaders): boolean {
  const marker = headers.get(MATRIX_PLATFORM_SESSION_HEADER)?.trim();
  // Bound the header before marker interpretation; untrusted callers are also blocked in proxy.ts.
  if (!marker || marker.length > MAX_PLATFORM_HEADER_LENGTH) return false;
  return marker === "native" || marker === "platform";
}
