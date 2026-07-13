import * as SecureStore from "expo-secure-store";

const SETTINGS_KEY = "matrix_os_settings";
const GATEWAY_CONNECTION_KEY = "matrix_os_gateway_connection";
export const HOSTED_GATEWAY_URL = "https://app.matrix-os.com";
const HOSTED_GATEWAY_ID = "matrix-os-hosted";
const CUSTOM_GATEWAY_ID = "matrix-os-custom";

export interface GatewayConnection {
  id: string;
  url: string;
  /** Full Authorization header value for non-Clerk gateways, e.g. "Basic ...". */
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

export function isHostedGatewayUrl(url: string): boolean {
  return normalizeGatewayUrl(url) === HOSTED_GATEWAY_URL;
}

export function normalizeGatewayUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("Enter your Matrix OS URL.");
  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `${defaultProtocolForHost(trimmed)}://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withProtocol);
  } catch {
    throw new Error("Enter a valid Matrix OS URL.");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Matrix OS URL must start with http:// or https://.");
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/+$/, "");
}

function defaultProtocolForHost(host: string): "http" | "https" {
  const withoutPath = host.split(/[/?#]/, 1)[0]?.replace(/^\[/, "").replace(/\]$/, "") ?? host;
  if (withoutPath === "localhost") return "http";
  if (/^\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?$/.test(withoutPath)) return "http";
  return "https";
}

export async function getSelectedGatewayConnection(): Promise<GatewayConnection> {
  const raw = await SecureStore.getItemAsync(GATEWAY_CONNECTION_KEY);
  if (!raw) return HOSTED_GATEWAY;
  try {
    const parsed = JSON.parse(raw) as Partial<GatewayConnection>;
    if (typeof parsed.url !== "string") return HOSTED_GATEWAY;
    const url = normalizeGatewayUrl(parsed.url);
    if (url === HOSTED_GATEWAY_URL) return HOSTED_GATEWAY;
    return {
      id: typeof parsed.id === "string" ? parsed.id : CUSTOM_GATEWAY_ID,
      url,
      token: typeof parsed.token === "string" && parsed.token.trim() ? parsed.token : undefined,
      name: typeof parsed.name === "string" && parsed.name.trim() ? parsed.name : "Self-hosted Matrix OS",
      addedAt: typeof parsed.addedAt === "number" ? parsed.addedAt : Date.now(),
    };
  } catch {
    return HOSTED_GATEWAY;
  }
}

export async function saveSelectedGatewayUrl(input: string): Promise<GatewayConnection> {
  const url = normalizeGatewayUrl(input);
  if (url === HOSTED_GATEWAY_URL) {
    await SecureStore.deleteItemAsync(GATEWAY_CONNECTION_KEY);
    return HOSTED_GATEWAY;
  }
  const gateway: GatewayConnection = {
    id: CUSTOM_GATEWAY_ID,
    url,
    name: "Self-hosted Matrix OS",
    addedAt: Date.now(),
  };
  await SecureStore.setItemAsync(GATEWAY_CONNECTION_KEY, JSON.stringify(gateway));
  return gateway;
}

export async function saveSelectedGatewayBasicAuth(input: string, username: string, password: string): Promise<GatewayConnection> {
  const url = normalizeGatewayUrl(input);
  if (url === HOSTED_GATEWAY_URL) {
    throw new Error("Use Google or GitHub for Matrix OS Cloud.");
  }
  const cleanUsername = username.trim();
  if (!cleanUsername) throw new Error("Enter the Basic Auth username.");
  if (!password) throw new Error("Enter the Basic Auth password.");
  const gateway: GatewayConnection = {
    id: CUSTOM_GATEWAY_ID,
    url,
    token: `Basic ${encodeBasicAuth(cleanUsername, password)}`,
    name: "Self-hosted Matrix OS",
    addedAt: Date.now(),
  };
  await SecureStore.setItemAsync(GATEWAY_CONNECTION_KEY, JSON.stringify(gateway));
  return gateway;
}

function encodeBasicAuth(username: string, password: string): string {
  const value = `${username}:${password}`;
  if (typeof btoa === "function") return btoa(value);

  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let output = "";
  let i = 0;
  while (i < value.length) {
    const a = value.charCodeAt(i++) & 0xff;
    const b = i < value.length ? value.charCodeAt(i++) & 0xff : Number.NaN;
    const c = i < value.length ? value.charCodeAt(i++) & 0xff : Number.NaN;
    const triple = (a << 16) | ((Number.isNaN(b) ? 0 : b) << 8) | (Number.isNaN(c) ? 0 : c);
    output += alphabet[(triple >> 18) & 63];
    output += alphabet[(triple >> 12) & 63];
    output += Number.isNaN(b) ? "=" : alphabet[(triple >> 6) & 63];
    output += Number.isNaN(c) ? "=" : alphabet[triple & 63];
  }
  return output;
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
