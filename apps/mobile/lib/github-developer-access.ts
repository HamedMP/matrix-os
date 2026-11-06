import { z } from "zod/v4";

import { isSafeSessionId } from "@/lib/terminal-state";

const GithubDeveloperStatusSchema = z.object({
  installed: z.boolean(),
  authenticated: z.boolean(),
  user: z.string().min(1).max(128).nullable(),
  gitProtocol: z.enum(["ssh", "https"]).nullable(),
  sshStatus: z.enum(["verified", "setup_required", "unavailable"]),
  commitIdentity: z.object({
    status: z.enum(["ready", "missing", "unavailable"]),
    label: z.string().min(1).max(256).nullable(),
  }),
  ready: z.boolean(),
  errorCode: z.string().regex(/^[a-z0-9_]{1,64}$/).nullable(),
});

export type GithubDeveloperStatus = z.infer<typeof GithubDeveloperStatusSchema>;
export type GithubDeveloperStatusResult =
  | { ok: true; status: GithubDeveloperStatus }
  | { ok: false; error: "GitHub developer access unavailable" };

type GatewayFetch = (path: string, init?: RequestInit) => Promise<Response>;

const UNAVAILABLE = { ok: false, error: "GitHub developer access unavailable" } as const;

export async function getGithubDeveloperStatus(
  fetchGateway: GatewayFetch,
): Promise<GithubDeveloperStatusResult> {
  try {
    const response = await fetchGateway("/api/github/status");
    if (!response.ok) return UNAVAILABLE;

    const parsed = GithubDeveloperStatusSchema.safeParse(await response.json());
    if (!parsed.success) return UNAVAILABLE;

    const status = parsed.data;
    const prerequisitesReady = status.installed
      && status.authenticated
      && status.gitProtocol === "ssh"
      && status.sshStatus === "verified"
      && status.commitIdentity.status === "ready";
    return { ok: true, status: { ...status, ready: status.ready && prerequisitesReady } };
  } catch (error: unknown) {
    logGithubWarning("status unavailable", error);
    return UNAVAILABLE;
  }
}

/** Create only the bounded, fixed-command GitHub setup tab. */
export async function createGithubDeveloperSetupSession(
  fetchGateway: GatewayFetch,
): Promise<string | null> {
  try {
    const ensured = await fetchGateway("/api/terminal/workspaces/ensure", {
      method: "POST",
      body: "{}",
      headers: { "Content-Type": "application/json" },
    });
    if (!ensured.ok) return null;

    const ensuredBody = await safeJson(ensured);
    const workspaceId = workspaceIdFrom(ensuredBody);
    if (!workspaceId) return null;

    const created = await fetchGateway(`/api/terminal/workspaces/${workspaceId}/tabs`, {
      method: "POST",
      body: JSON.stringify({
        name: `GitHub setup ${randomSuffix()}`,
        cwd: "projects",
        command: ["matrix-github-developer-login"],
      }),
      headers: { "Content-Type": "application/json" },
    });
    if (!created.ok) return null;

    const createdBody = await safeJson(created);
    const tabId = tabIdFrom(createdBody);
    if (!tabId) return null;
    const terminalRef = `${workspaceId}:${tabId}`;
    return isSafeSessionId(terminalRef) ? terminalRef : null;
  } catch (error: unknown) {
    logGithubWarning("setup session unavailable", error);
    return null;
  }
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (error: unknown) {
    logGithubWarning("response returned invalid JSON", error);
    return null;
  }
}

function logGithubWarning(message: string, error: unknown): void {
  console.warn(`[mobile] GitHub developer access ${message}`, error instanceof Error ? error.name : "unknown");
}

function workspaceIdFrom(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const workspace = "workspace" in value ? value.workspace : null;
  if (!workspace || typeof workspace !== "object" || !("id" in workspace)) return null;
  return typeof workspace.id === "string" && /^tws_[0-9a-f]{32}$/.test(workspace.id)
    ? workspace.id
    : null;
}

function tabIdFrom(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const tab = "tab" in value ? value.tab : null;
  if (!tab || typeof tab !== "object" || !("id" in tab)) return null;
  return typeof tab.id === "string" ? tab.id : null;
}

function randomSuffix(): string {
  const crypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (crypto && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID().replace(/-/g, "").slice(0, 7);
  }
  return Math.random().toString(36).slice(2, 9).padEnd(7, "0").slice(0, 7);
}
