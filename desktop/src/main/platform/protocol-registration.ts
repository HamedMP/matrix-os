import type { VerifiedDesktopPreviewContext } from "../preview-pair-context";
export const WINDOWS_PROTOCOL_SCHEMES = ["matrixos", "matrix-os"] as const;

export interface ProtocolClientApp {
  readonly isPackaged: boolean;
  setAsDefaultProtocolClient(scheme: string): boolean;
}

export function registerWindowsProtocolClients(
  electronApp: ProtocolClientApp,
  platform: NodeJS.Platform = process.platform,
  previewContext?: VerifiedDesktopPreviewContext,
  schemes: readonly string[] = WINDOWS_PROTOCOL_SCHEMES,
): string[] {
  if (previewContext || platform !== "win32" || !electronApp.isPackaged) return [];

  return schemes.filter(
    (scheme) => !electronApp.setAsDefaultProtocolClient(scheme),
  );
}
