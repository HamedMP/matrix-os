import { RuntimeSummarySchema, type RuntimeSummary } from "@matrix-os/contracts";
import type { AuthService } from "../auth/auth-service";

const RUNTIME_SUMMARY_TIMEOUT_MS = 10_000;

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

function buildSummaryUrl(origin: string, runtimeSlot: string): string {
  const url = new URL("/api/coding-agents/summary", origin);
  if (runtimeSlot !== "primary") {
    url.searchParams.set("runtime", runtimeSlot);
  }
  return url.toString();
}

export async function fetchCodingAgentRuntimeSummary(
  auth: AuthService,
  fetchFn: FetchFn = fetch,
): Promise<RuntimeSummary> {
  const token = auth.getToken();
  if (!token) {
    throw new Error("runtime summary unavailable");
  }

  const status = auth.getStatus();
  const url = buildSummaryUrl(auth.getGatewayOrigin(), status.runtimeSlot);
  const res = await fetchFn(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(RUNTIME_SUMMARY_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error("runtime summary unavailable");
  }

  const body = await res.json();
  const parsed = RuntimeSummarySchema.safeParse(body);
  if (!parsed.success) {
    throw new Error("runtime summary unavailable");
  }
  return parsed.data;
}
