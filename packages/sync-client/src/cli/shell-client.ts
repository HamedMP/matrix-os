export interface ShellClientOptions {
  gatewayUrl: string;
  token?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface ShellClient {
  listSessions(): Promise<unknown[]>;
  createSession(input: {
    name: string;
    cwd?: string;
    layout?: string;
    cmd?: string;
  }): Promise<Record<string, unknown>>;
  deleteSession(name: string, options?: { force?: boolean }): Promise<void>;
}

export interface ShellClientError extends Error {
  code: string;
}

export function createShellClient(options: ShellClientOptions): ShellClient {
  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const base = options.gatewayUrl.replace(/\/+$/, "");

  async function request(path: string, init: RequestInit = {}): Promise<unknown> {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, key) => {
      headers[key] = value;
    });
    if (options.token) {
      headers.Authorization = `Bearer ${options.token}`;
    }
    if (init.body && !headers["Content-Type"] && !headers["content-type"]) {
      headers["Content-Type"] = "application/json";
    }

    const res = await fetchImpl(`${base}${path}`, {
      ...init,
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const payload = await res.json().catch(() => ({}));

    if (!res.ok) {
      const code =
        typeof payload === "object" &&
        payload !== null &&
        "error" in payload &&
        typeof (payload as { error?: { code?: unknown } }).error?.code === "string"
          ? (payload as { error: { code: string } }).error.code
          : "request_failed";
      throw Object.assign(new Error("Request failed"), { code });
    }

    return payload;
  }

  return {
    async listSessions() {
      const payload = await request("/api/sessions");
      if (
        typeof payload === "object" &&
        payload !== null &&
        "sessions" in payload &&
        Array.isArray((payload as { sessions: unknown }).sessions)
      ) {
        return (payload as { sessions: unknown[] }).sessions;
      }
      return [];
    },
    async createSession(input) {
      return (await request("/api/sessions", {
        method: "POST",
        body: JSON.stringify(input),
      })) as Record<string, unknown>;
    },
    async deleteSession(name, options = {}) {
      const suffix = options.force ? "?force=1" : "";
      await request(`/api/sessions/${encodeURIComponent(name)}${suffix}`, {
        method: "DELETE",
      });
    },
  };
}
