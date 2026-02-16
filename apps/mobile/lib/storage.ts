import * as SecureStore from "expo-secure-store";

const GATEWAYS_KEY = "matrix_os_gateways";
const ACTIVE_GATEWAY_KEY = "matrix_os_active_gateway";
const SETTINGS_KEY = "matrix_os_settings";

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

export async function getGateways(): Promise<GatewayConnection[]> {
  const raw = await SecureStore.getItemAsync(GATEWAYS_KEY);
  if (!raw) return [];
  return JSON.parse(raw);
}

export async function saveGateway(gw: GatewayConnection): Promise<void> {
  const existing = await getGateways();
  const idx = existing.findIndex((g) => g.id === gw.id);
  if (idx >= 0) {
    existing[idx] = gw;
  } else {
    existing.push(gw);
  }
  await SecureStore.setItemAsync(GATEWAYS_KEY, JSON.stringify(existing));
}

export async function removeGateway(id: string): Promise<void> {
  const existing = await getGateways();
  const filtered = existing.filter((g) => g.id !== id);
  await SecureStore.setItemAsync(GATEWAYS_KEY, JSON.stringify(filtered));
  const active = await getActiveGatewayId();
  if (active === id) {
    await SecureStore.deleteItemAsync(ACTIVE_GATEWAY_KEY);
  }
}

export async function getActiveGatewayId(): Promise<string | null> {
  return SecureStore.getItemAsync(ACTIVE_GATEWAY_KEY);
}

export async function setActiveGatewayId(id: string): Promise<void> {
  await SecureStore.setItemAsync(ACTIVE_GATEWAY_KEY, id);
}

export async function getActiveGateway(): Promise<GatewayConnection | null> {
  const id = await getActiveGatewayId();
  if (!id) return null;
  const gateways = await getGateways();
  return gateways.find((g) => g.id === id) ?? null;
}

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
