import * as SecureStore from "expo-secure-store";

const SETTINGS_KEY = "matrix_os_settings";
export const HOSTED_GATEWAY_URL = "https://app.matrix-os.com";
const HOSTED_GATEWAY_ID = "matrix-os-hosted";

export interface GatewayConnection {
  id: string;
  url: string;
  token?: string;
  name: string;
  addedAt: number;
}

export interface AppSettings {
  biometricEnabled: boolean;
  theme: "system" | "light" | "dark";
  notificationsEnabled: boolean;
}

const DEFAULT_SETTINGS: AppSettings = {
  biometricEnabled: false,
  theme: "system",
  notificationsEnabled: true,
};

export const HOSTED_GATEWAY: GatewayConnection = {
  id: HOSTED_GATEWAY_ID,
  url: HOSTED_GATEWAY_URL,
  name: "Matrix OS Cloud",
  addedAt: 0,
};

export async function getSettings(): Promise<AppSettings> {
  const raw = await SecureStore.getItemAsync(SETTINGS_KEY);
  if (!raw) return DEFAULT_SETTINGS;
  return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
}

export async function saveSettings(settings: Partial<AppSettings>): Promise<void> {
  const current = await getSettings();
  const updated = { ...current, ...settings };
  await SecureStore.setItemAsync(SETTINGS_KEY, JSON.stringify(updated));
}

export function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
