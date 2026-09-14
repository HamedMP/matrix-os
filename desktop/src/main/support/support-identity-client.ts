import {
  SupportIdentityResponseSchema,
  type SupportIdentityResponse,
} from "@matrix-os/contracts";
import type { AuthService } from "../auth/auth-service";

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;
type SupportIdentityAuth = Pick<AuthService, "getGatewayOrigin" | "getStatus" | "getToken">;

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 16 * 1024;

async function readBoundedResponseText(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      totalBytes += chunk.value.byteLength;
      if (totalBytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("support identity response too large");
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

export async function fetchDesktopSupportIdentity(
  auth: SupportIdentityAuth,
  options: { fetchFn?: FetchFn; timeoutMs?: number } = {},
): Promise<SupportIdentityResponse> {
  const initialStatus = auth.getStatus();
  const token = auth.getToken();
  if (!initialStatus.signedIn || !token) return { status: "unavailable" };

  try {
    const endpoint = new URL("/api/support/identity", auth.getGatewayOrigin());
    if (endpoint.protocol !== "https:" && endpoint.protocol !== "http:") {
      return { status: "unavailable" };
    }
    const fetchFn = options.fetchFn ?? ((input: string, init?: RequestInit) => fetch(input, init));
    const response = await fetchFn(endpoint.toString(), {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    if (!response.ok) return { status: "unavailable" };

    const parsed = SupportIdentityResponseSchema.safeParse(
      JSON.parse(await readBoundedResponseText(response)),
    );
    if (!parsed.success || parsed.data.status !== "verified") {
      return { status: "unavailable" };
    }

    const currentStatus = auth.getStatus();
    if (
      !currentStatus.signedIn ||
      currentStatus.userId !== initialStatus.userId ||
      currentStatus.authGeneration !== initialStatus.authGeneration ||
      parsed.data.distinctId !== initialStatus.userId
    ) {
      return { status: "unavailable" };
    }
    return parsed.data;
  } catch (error: unknown) {
    console.warn(
      "[support] identity verification unavailable:",
      error instanceof Error ? error.name : "UnknownError",
    );
    return { status: "unavailable" };
  }
}
