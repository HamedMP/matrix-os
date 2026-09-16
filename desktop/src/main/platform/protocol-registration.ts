export const WINDOWS_PROTOCOL_SCHEMES = ["matrixos", "matrix-os"] as const;

export interface ProtocolClientApp {
  readonly isPackaged: boolean;
  setAsDefaultProtocolClient(scheme: string): boolean;
}

export function registerWindowsProtocolClients(
  electronApp: ProtocolClientApp,
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (platform !== "win32" || !electronApp.isPackaged) return [];

  return WINDOWS_PROTOCOL_SCHEMES.filter(
    (scheme) => !electronApp.setAsDefaultProtocolClient(scheme),
  );
}
