import {
  SyncDeviceCredentialSchema,
  SyncDeviceEnrollmentRequestSchema,
  SyncDeviceRefreshRequestSchema,
} from "@matrix-os/contracts/sync";
import type { AuthData } from "./token-store.js";

const AUTH_REQUEST_TIMEOUT_MS = 10_000;
const MAX_AUTH_RESPONSE_BYTES = 32 * 1024;

export class SyncDeviceAuthError extends Error {
  constructor(readonly code: "not_enrolled" | "needs_sign_in" | "unavailable" | "invalid_response") {
    super(code);
    this.name = "SyncDeviceAuthError";
  }
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_AUTH_RESPONSE_BYTES) {
    throw new SyncDeviceAuthError("invalid_response");
  }
  if (!response.body) throw new SyncDeviceAuthError("invalid_response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_AUTH_RESPONSE_BYTES) {
      await reader.cancel();
      throw new SyncDeviceAuthError("invalid_response");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (err: unknown) {
    if (!(err instanceof SyntaxError)) throw err;
    throw new SyncDeviceAuthError("invalid_response");
  }
}

function endpoint(platformUrl: string, action: "enroll" | "refresh" | "revoke"): string {
  return new URL(`/api/auth/sync-device/${action}`, platformUrl).toString();
}

export async function enrollSyncDeviceAuth(options: {
  platformUrl: string;
  desktopAccessToken: string;
  deviceName: string;
  expected: Pick<AuthData, "userId" | "handle" | "runtimeSlot">;
  fetchFn?: typeof fetch;
}): Promise<AuthData> {
  const fetchFn = options.fetchFn ?? fetch;
  const token = options.desktopAccessToken;
  if (!token || token.length > 16_384) {
    throw new SyncDeviceAuthError("needs_sign_in");
  }
  let response: Response;
  try {
    response = await fetchFn(endpoint(options.platformUrl, "enroll"), {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(SyncDeviceEnrollmentRequestSchema.parse({
        deviceName: options.deviceName,
      })),
      signal: AbortSignal.timeout(AUTH_REQUEST_TIMEOUT_MS),
    });
  } catch (err: unknown) {
    if (err instanceof SyncDeviceAuthError) throw err;
    throw new SyncDeviceAuthError("unavailable");
  }
  if (response.status === 401 || response.status === 403) {
    throw new SyncDeviceAuthError("needs_sign_in");
  }
  if (!response.ok) throw new SyncDeviceAuthError("unavailable");
  const parsed = SyncDeviceCredentialSchema.safeParse(await readBoundedJson(response));
  if (!parsed.success) throw new SyncDeviceAuthError("invalid_response");
  if (
    parsed.data.userId !== options.expected.userId
    || parsed.data.handle !== options.expected.handle
    || parsed.data.runtimeSlot !== (options.expected.runtimeSlot ?? "primary")
  ) {
    throw new SyncDeviceAuthError("invalid_response");
  }
  return parsed.data;
}

function refreshBody(auth: AuthData): { refreshToken: string } {
  if (!auth.refreshToken) throw new SyncDeviceAuthError("not_enrolled");
  const parsed = SyncDeviceRefreshRequestSchema.safeParse({ refreshToken: auth.refreshToken });
  if (!parsed.success) throw new SyncDeviceAuthError("not_enrolled");
  return parsed.data;
}

export async function refreshSyncDeviceAuth(options: {
  platformUrl: string;
  auth: AuthData;
  save: (auth: AuthData) => Promise<void>;
  fetchFn?: typeof fetch;
}): Promise<AuthData> {
  const fetchFn = options.fetchFn ?? fetch;
  let response: Response;
  try {
    response = await fetchFn(endpoint(options.platformUrl, "refresh"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(refreshBody(options.auth)),
      signal: AbortSignal.timeout(AUTH_REQUEST_TIMEOUT_MS),
    });
  } catch (err: unknown) {
    if (err instanceof SyncDeviceAuthError) throw err;
    throw new SyncDeviceAuthError("unavailable");
  }
  if (response.status === 401 || response.status === 403) {
    throw new SyncDeviceAuthError("needs_sign_in");
  }
  if (!response.ok) throw new SyncDeviceAuthError("unavailable");
  const parsed = SyncDeviceCredentialSchema.safeParse(await readBoundedJson(response));
  if (!parsed.success) throw new SyncDeviceAuthError("invalid_response");
  if (
    parsed.data.userId !== options.auth.userId
    || parsed.data.handle !== options.auth.handle
    || parsed.data.runtimeSlot !== (options.auth.runtimeSlot ?? "primary")
  ) {
    throw new SyncDeviceAuthError("invalid_response");
  }
  const next: AuthData = parsed.data;
  await options.save(next);
  return next;
}

export async function revokeSyncDeviceAuth(options: {
  platformUrl: string;
  auth: AuthData;
  fetchFn?: typeof fetch;
}): Promise<void> {
  const fetchFn = options.fetchFn ?? fetch;
  let response: Response;
  try {
    response = await fetchFn(endpoint(options.platformUrl, "revoke"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(refreshBody(options.auth)),
      signal: AbortSignal.timeout(AUTH_REQUEST_TIMEOUT_MS),
    });
  } catch (err: unknown) {
    if (err instanceof SyncDeviceAuthError) throw err;
    throw new SyncDeviceAuthError("unavailable");
  }
  if (!response.ok) throw new SyncDeviceAuthError("unavailable");
}
