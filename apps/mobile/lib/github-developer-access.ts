import { z } from "zod/v4";
import {
  GithubDeveloperStatusSchema,
  GithubDeveloperSetupOperationSchema,
  type GithubDeveloperStatus,
  type GithubDeveloperSetupOperation,
} from "@matrix-os/contracts";

export type { GithubDeveloperStatus } from "@matrix-os/contracts";
export type GithubDeveloperStatusResult =
  | { ok: true; status: GithubDeveloperStatus }
  | { ok: false; error: "GitHub developer access unavailable" };
type GatewayFetch = (path: string, init?: RequestInit) => Promise<Response>;
const UNAVAILABLE = { ok: false, error: "GitHub developer access unavailable" } as const;
const OperationId = z.uuid();

export async function getGithubDeveloperStatus(fetchGateway: GatewayFetch): Promise<GithubDeveloperStatusResult> {
  try {
    const status = GithubDeveloperStatusSchema.parse(await request(fetchGateway, "status"));
    const prerequisitesReady = status.installed && status.authenticated
      && status.gitProtocol === "ssh" && status.sshStatus === "verified"
      && status.commitIdentity.status === "ready";
    return { ok: true, status: { ...status, ready: status.ready && prerequisitesReady } };
  } catch (error: unknown) {
    logGithubWarning(error);
    return UNAVAILABLE;
  }
}

export async function githubDeveloperSetup(
  fetchGateway: GatewayFetch,
  action: "start" | "get" | "cancel",
  id?: string,
  signal?: AbortSignal,
): Promise<GithubDeveloperSetupOperation> {
  if (action !== "start" && !OperationId.safeParse(id).success) throw new Error("GitHub setup unavailable");
  const path = action === "start" ? "setup" : `setup/${id}${action === "cancel" ? "/cancel" : ""}`;
  try {
    const result = GithubDeveloperSetupOperationSchema.parse(await request(fetchGateway, path, action !== "get", signal));
    if (action !== "start" && result.id !== id) throw new Error("Operation changed");
    return result;
  } catch (error: unknown) {
    logGithubWarning(error);
    throw new Error("GitHub setup unavailable");
  }
}

async function request(fetchGateway: GatewayFetch, path: string, post = false, signal?: AbortSignal): Promise<unknown> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, 10_000);
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  try {
    const response = await fetchGateway(`/api/github/${path}`, {
      signal: controller.signal,
      ...(post ? { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } } : {}),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("Request failed");
    }
    const text = await response.text();
    if (text.length > 16 * 1024) throw new Error("Response too large");
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

function logGithubWarning(error: unknown): void {
  console.warn("[mobile] GitHub developer access unavailable", error instanceof Error ? error.name : "unknown");
}
