export async function requestAckToken(
  slug: string,
  gatewayUrl?: string,
): Promise<string> {
  const base = gatewayUrl ?? "";
  const res = await fetch(`${base}/api/apps/${slug}/ack`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`Failed to request ack token: ${res.status} ${(body as { error?: string }).error ?? ""}`);
  }

  const { ack } = (await res.json()) as { ack: string };
  return ack;
}

export async function openAppSession(
  slug: string,
  opts?: { ack?: string; gatewayUrl?: string },
): Promise<{ expiresAt: number }> {
  const base = opts?.gatewayUrl ?? "";
  const body = opts?.ack ? JSON.stringify({ ack: opts.ack }) : undefined;

  const res = await fetch(`${base}/api/apps/${slug}/session`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body,
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const responseBody = await res.json().catch(() => ({}));
    throw new Error(
      `Failed to open session: ${res.status} ${(responseBody as { error?: string }).error ?? ""}`,
    );
  }

  return (await res.json()) as { expiresAt: number };
}
