const SAFE_GATEWAY_STATUS = /^[a-z][a-z0-9_-]{0,31}$/;

export interface GatewayHealth {
  reachable: boolean;
  status: string;
}

export async function probeGatewayHealth(
  gatewayUrl: string,
  token?: string,
): Promise<GatewayHealth> {
  const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
  const primary = await fetchGatewayHealth(`${gatewayUrl}/api/system/info`, headers);
  // Only fall back to legacy /health when /api/system/info does not exist.
  // Other non-2xx responses should surface the real gateway auth/reachability state.
  if (primary.res.status !== 404) {
    return readGatewayStatus(primary.res, primary.body);
  }

  const fallback = await fetchGatewayHealth(`${gatewayUrl}/health`, headers);
  return readGatewayStatus(fallback.res, fallback.body);
}

async function fetchGatewayHealth(
  url: string,
  headers?: Record<string, string>,
): Promise<{ res: Response; body: unknown }> {
  const res = await fetch(url, {
    ...(headers ? { headers } : {}),
    signal: AbortSignal.timeout(10_000),
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch (err: unknown) {
    if (!(err instanceof SyntaxError) && !(err instanceof TypeError)) {
      throw err;
    }
  }
  return { res, body };
}

function readGatewayStatus(res: Response, body: unknown): GatewayHealth {
  if (
    typeof body === "object" &&
    body !== null &&
    "status" in body &&
    typeof (body as { status?: unknown }).status === "string" &&
    SAFE_GATEWAY_STATUS.test((body as { status: string }).status)
  ) {
    return { reachable: res.ok, status: (body as { status: string }).status };
  }
  return { reachable: res.ok, status: res.ok ? "ok" : "unreachable" };
}
