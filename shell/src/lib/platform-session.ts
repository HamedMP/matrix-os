const MAX_PLATFORM_HEADER_LENGTH = 512;

type PlatformSessionHeaders = Pick<Headers, "get">;

export const MATRIX_NATIVE_APP_SESSION_HEADER = "x-matrix-native-app-session";
export const MATRIX_PLATFORM_SESSION_HEADER = "x-matrix-platform-session";

export function hasServerVerifiedMatrixSession(headers: PlatformSessionHeaders): boolean {
  const marker = headers.get(MATRIX_PLATFORM_SESSION_HEADER)?.trim();
  return marker === "native" && marker.length <= MAX_PLATFORM_HEADER_LENGTH;
}
