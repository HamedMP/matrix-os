// Platform device-authorization flow (FR-001), pure logic with injected fetch
// and clock so it is fully unit-testable. Contract verified by the 092
// prototype: specs/094-electron-macos-shell/contracts/gateway-contract.md.
import { AppError, classifyHttpStatus, classifyTransportError } from "../../shared/app-error";

export const DEVICE_CLIENT_ID = "matrix-os-desktop";
export const DEVICE_REDIRECT_URI = "matrixos://auth?status=approved";

const REQUEST_TIMEOUT_MS = 10_000;

export interface DeviceCodeResponse {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

export interface DeviceTokenResponse {
  accessToken: string;
  expiresAt: number;
  userId: string;
  handle: string;
  runtimeSlot?: string;
  // Optional, non-secret display profile (sidebar avatar/name). The platform
  // fills these from Clerk; absent for older gateways or when the profile
  // lookup degraded, so every consumer must treat them as optional.
  displayName?: string;
  imageUrl?: string;
  email?: string;
}

export class DeviceFlowError extends Error {
  readonly code: "expired" | "denied";

  constructor(code: "expired" | "denied") {
    super(code === "expired" ? "Sign-in request expired. Start again." : "Sign-in was denied.");
    this.name = "DeviceFlowError";
    this.code = code;
  }
}

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

async function postJson(fetchFn: FetchFn, url: string, body: unknown): Promise<Response> {
  try {
    return await fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err: unknown) {
    throw new AppError(classifyTransportError(err), { cause: err });
  }
}

async function parseJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const data: unknown = await response.json();
    if (data && typeof data === "object") return data as Record<string, unknown>;
  } catch (err: unknown) {
    throw new AppError("server", { cause: err });
  }
  throw new AppError("server");
}

export async function requestDeviceCode(options: {
  fetchFn: FetchFn;
  baseUrl: string;
}): Promise<DeviceCodeResponse> {
  const response = await postJson(options.fetchFn, `${options.baseUrl}/api/auth/device/code`, {
    clientId: DEVICE_CLIENT_ID,
    redirectUri: DEVICE_REDIRECT_URI,
  });
  if (!response.ok) {
    throw new AppError(classifyHttpStatus(response.status));
  }
  const data = await parseJson(response);
  const { deviceCode, userCode, verificationUri, expiresIn, interval } = data;
  if (
    typeof deviceCode !== "string" ||
    typeof userCode !== "string" ||
    typeof verificationUri !== "string" ||
    typeof expiresIn !== "number" ||
    typeof interval !== "number"
  ) {
    throw new AppError("server");
  }
  return { deviceCode, userCode, verificationUri, expiresIn, interval };
}

export async function pollForToken(options: {
  fetchFn: FetchFn;
  baseUrl: string;
  deviceCode: string;
  intervalSeconds: number;
  expiresInSeconds: number;
  sleep: (ms: number) => Promise<void>;
  clock?: () => number;
}): Promise<DeviceTokenResponse> {
  const clock = options.clock ?? Date.now;
  const deadline = clock() + options.expiresInSeconds * 1000;
  let intervalMs = Math.max(1, options.intervalSeconds) * 1000;

  for (;;) {
    const response = await postJson(options.fetchFn, `${options.baseUrl}/api/auth/device/token`, {
      deviceCode: options.deviceCode,
    });

    if (response.status === 200) {
      const data = await parseJson(response);
      const { accessToken, expiresAt, userId, handle } = data;
      if (
        typeof accessToken !== "string" ||
        typeof expiresAt !== "number" ||
        typeof userId !== "string" ||
        typeof handle !== "string"
      ) {
        throw new AppError("server");
      }
      const optionalString = (value: unknown): string | undefined =>
        typeof value === "string" && value.length > 0 ? value : undefined;
      return {
        accessToken,
        expiresAt,
        userId,
        handle,
        ...(optionalString(data.runtimeSlot) ? { runtimeSlot: optionalString(data.runtimeSlot) } : {}),
        ...(optionalString(data.displayName) ? { displayName: optionalString(data.displayName) } : {}),
        ...(optionalString(data.imageUrl) ? { imageUrl: optionalString(data.imageUrl) } : {}),
        ...(optionalString(data.email) ? { email: optionalString(data.email) } : {}),
      };
    }

    if (response.status === 410) throw new DeviceFlowError("expired");
    if (response.status === 429) {
      intervalMs += 5000;
    } else if (response.status !== 428) {
      throw new AppError(classifyHttpStatus(response.status));
    }

    if (clock() + intervalMs > deadline) throw new DeviceFlowError("expired");
    await options.sleep(intervalMs);
  }
}
