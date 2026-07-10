export type NativeAppRuntime = "linux-native";

export type NativeAppFilesystemPermission = "none" | "home-readonly" | "documents";

export interface NativeAppPermissions {
  filesystem: NativeAppFilesystemPermission;
  network: boolean;
  clipboard: boolean;
}

export interface NativeAppDefinition {
  id: string;
  name: string;
  command: string[];
  runtime: NativeAppRuntime;
  enabled: boolean;
  defaultWidth: number;
  defaultHeight: number;
  permissions: NativeAppPermissions;
}

export const SAFE_NATIVE_APP_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const SAFE_NATIVE_SESSION_ID = /^session_[A-Za-z0-9_-]{24,96}$/;
export const SAFE_NATIVE_STREAM_TOKEN = /^stream_[A-Za-z0-9_-]{24,96}$/;

export function createDefaultNativeAppRegistry(): NativeAppDefinition[] {
  return [
    {
      id: "xterm",
      name: "Xterm",
      command: ["xterm"],
      runtime: "linux-native",
      enabled: true,
      defaultWidth: 900,
      defaultHeight: 640,
      permissions: {
        filesystem: "none",
        network: false,
        clipboard: false,
      },
    },
    {
      id: "xcalc",
      name: "XCalc",
      command: ["xcalc"],
      runtime: "linux-native",
      enabled: true,
      defaultWidth: 420,
      defaultHeight: 560,
      permissions: {
        filesystem: "none",
        network: false,
        clipboard: false,
      },
    },
  ];
}

export function listEnabledNativeApps(registry: NativeAppDefinition[]): NativeAppDefinition[] {
  return registry.filter((app) => app.enabled && app.runtime === "linux-native");
}
