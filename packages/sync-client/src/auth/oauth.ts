import { exec } from "node:child_process";
import { platform } from "node:os";
import { saveAuth, type AuthData } from "./token-store.js";

export interface DeviceCodeResponse {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

export interface OAuthConfig {
  platformUrl: string;
  clientId: string;
}

export async function requestDeviceCode(
  config: OAuthConfig,
): Promise<DeviceCodeResponse> {
  const url = `${config.platformUrl}/api/auth/device/code`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientId: config.clientId }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    throw new Error(`Device code request failed: ${res.status}`);
  }

  return (await res.json()) as DeviceCodeResponse;
}

export function openBrowser(url: string): void {
  const os = platform();
  const cmd =
    os === "darwin"
      ? `open "${url}"`
      : os === "win32"
        ? `start "${url}"`
        : `xdg-open "${url}"`;

  exec(cmd, (err) => {
    if (err) {
      console.error(`Could not open browser. Visit: ${url}`);
    }
  });
}

export async function pollForToken(
  config: OAuthConfig,
  deviceCode: string,
  interval: number,
  expiresIn: number,
): Promise<AuthData> {
  const deadline = Date.now() + expiresIn * 1000;
  const pollUrl = `${config.platformUrl}/api/auth/device/token`;

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, interval * 1000));

    const res = await fetch(pollUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceCode, clientId: config.clientId }),
      signal: AbortSignal.timeout(10_000),
    });

    if (res.ok) {
      const data = (await res.json()) as AuthData;
      await saveAuth(data);
      return data;
    }

    if (res.status === 428) {
      continue;
    }

    const body = await res.text().catch(() => "");
    throw new Error(`Token polling failed: ${res.status} ${body}`);
  }

  throw new Error("Device authorization timed out");
}

export async function login(config: OAuthConfig): Promise<AuthData> {
  const deviceCode = await requestDeviceCode(config);

  console.log(`\nVisit: ${deviceCode.verificationUri}`);
  console.log(`Enter code: ${deviceCode.userCode}\n`);

  openBrowser(deviceCode.verificationUri);

  return pollForToken(
    config,
    deviceCode.deviceCode,
    deviceCode.interval,
    deviceCode.expiresIn,
  );
}
