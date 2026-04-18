import { execFile } from "node:child_process";
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
  // execFile (not exec) so the URL is passed as argv -- no shell, no command
  // injection. The URL comes from the platform but treat it as untrusted.
  const os = platform();
  const cmd = os === "darwin" ? "open" : os === "win32" ? "cmd" : "xdg-open";
  const args = os === "win32" ? ["/c", "start", "", url] : [url];

  execFile(cmd, args, (err) => {
    if (err) {
      console.error(`Could not open browser. Visit: ${url}`);
    }
  });
}

/**
 * Poll the platform for a device-code grant. Implements RFC 8628 §3.5
 * polling rules: respect the server's interval, extend on `slow_down`,
 * give up on `expired_token`. Persists the resulting AuthData via
 * `saveAuth`; pass `tokenStorePath` to override the default
 * `~/.matrixos/auth.json` location (used by tests).
 */
export async function pollForToken(
  config: OAuthConfig,
  deviceCode: string,
  intervalSec: number,
  expiresInSec: number,
  tokenStorePath?: string,
): Promise<AuthData> {
  const deadline = Date.now() + expiresInSec * 1000;
  const pollUrl = `${config.platformUrl}/api/auth/device/token`;
  let interval = intervalSec;

  while (Date.now() < deadline) {
    await sleep(interval * 1000);

    const res = await fetch(pollUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceCode, clientId: config.clientId }),
      signal: AbortSignal.timeout(10_000),
    });

    if (res.ok) {
      const data = (await res.json()) as AuthData;
      await saveAuth(data, tokenStorePath);
      return data;
    }

    if (res.status === 428) {
      // authorization_pending -- keep polling.
      continue;
    }

    if (res.status === 429) {
      // slow_down -- per RFC 8628 §3.5, MUST increase the polling interval.
      interval = interval + 5;
      continue;
    }

    if (res.status === 410) {
      throw new Error("Device code expired before authorization completed");
    }

    const body = await res.text().catch(() => "");
    throw new Error(`Token polling failed: ${res.status} ${body}`);
  }

  throw new Error("Device authorization timed out");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface LoginOptions extends OAuthConfig {
  tokenStorePath?: string;
}

export async function login(options: LoginOptions): Promise<AuthData> {
  const deviceCode = await requestDeviceCode(options);

  console.log(`\nVisit: ${deviceCode.verificationUri}`);
  console.log(`Enter code: ${deviceCode.userCode}\n`);

  openBrowser(deviceCode.verificationUri);

  return pollForToken(
    options,
    deviceCode.deviceCode,
    deviceCode.interval,
    deviceCode.expiresIn,
    options.tokenStorePath,
  );
}
