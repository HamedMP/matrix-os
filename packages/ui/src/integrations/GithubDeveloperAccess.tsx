import type { ProviderSettingsAccess } from "@matrix-os/contracts";
import type { IntegrationCatalogItem } from "@matrix-os/contracts/integration-marketplace";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { IntegrationRowPresentation } from "./IntegrationMarketplace.js";

const MAX_ACCOUNT_LABEL_LENGTH = 128;
// Match the additive core contract, including the confirmed name and email.
const MAX_IDENTITY_LABEL_LENGTH = 525;

export interface GithubDeveloperAccessStatus {
  installed: boolean;
  authenticated: boolean;
  user: string | null;
  gitProtocol: "ssh" | "https" | null;
  sshStatus: "verified" | "setup_required" | "unavailable";
  commitIdentity: {
    status: "ready" | "missing" | "unavailable";
    label: string | null;
  };
  ready: boolean;
  errorCode: string | null;
}

export interface GithubDeveloperAccessClient {
  status(signal: AbortSignal): Promise<unknown>;
  setupAccess(signal: AbortSignal): Promise<ProviderSettingsAccess>;
  startSetup(): Promise<boolean>;
}

function boundedLabel(value: unknown, maxLength: number): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength
    ? value
    : null;
}

/**
 * Temporary compatibility boundary while ENG-377 is separately approvable.
 * Missing additive fields are deliberately normalized to not-ready.
 */
export function parseGithubDeveloperAccessStatus(value: unknown): GithubDeveloperAccessStatus | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.installed !== "boolean" || typeof record.authenticated !== "boolean") return null;
  const rawIdentity = record.commitIdentity;
  const identityRecord = rawIdentity && typeof rawIdentity === "object" && !Array.isArray(rawIdentity)
    ? rawIdentity as Record<string, unknown>
    : null;
  let identityStatus: GithubDeveloperAccessStatus["commitIdentity"]["status"] = "unavailable";
  if (identityRecord?.status === "ready"
    || identityRecord?.status === "missing"
    || identityRecord?.status === "unavailable") {
    identityStatus = identityRecord.status;
  }
  const identityLabel = boundedLabel(identityRecord?.label, MAX_IDENTITY_LABEL_LENGTH);
  const commitIdentity = identityStatus === "ready" && identityLabel === null
    ? { status: "unavailable" as const, label: null }
    : { status: identityStatus, label: identityStatus === "ready" ? identityLabel : null };
  const sshStatus = record.sshStatus === "verified"
    || record.sshStatus === "setup_required"
    || record.sshStatus === "unavailable"
    ? record.sshStatus
    : "unavailable";
  const gitProtocol = record.gitProtocol === "ssh" || record.gitProtocol === "https"
    ? record.gitProtocol
    : null;
  const user = boundedLabel(record.user, MAX_ACCOUNT_LABEL_LENGTH);
  const authenticated = record.authenticated && user !== null;
  const ready = record.ready === true
    && record.installed
    && authenticated
    && gitProtocol === "ssh"
    && sshStatus === "verified"
    && commitIdentity.status === "ready";

  return {
    installed: record.installed,
    authenticated,
    user,
    gitProtocol,
    sshStatus,
    commitIdentity,
    ready,
    errorCode: typeof record.errorCode === "string" && record.errorCode.length <= 64
      ? record.errorCode
      : null,
  };
}

function readinessLabel(status: GithubDeveloperAccessStatus["sshStatus"]): string {
  if (status === "verified") return "SSH verified";
  if (status === "setup_required") return "SSH setup required";
  return "SSH unavailable";
}

function identityLabel(status: GithubDeveloperAccessStatus["commitIdentity"]): string {
  if (status.status === "ready") return status.label ?? "Commit identity ready";
  if (status.status === "missing") return "Commit identity missing";
  return "Commit identity unavailable";
}

export const GITHUB_DEVELOPER_SERVICE_ID = "github-developer";

export function withGithubDeveloperCatalogEntry(services: readonly IntegrationCatalogItem[]): IntegrationCatalogItem[] {
  const github = services.find(service => service.id === "github");
  const developer: IntegrationCatalogItem = {
    id: GITHUB_DEVELOPER_SERVICE_ID,
    name: "GitHub Developer",
    category: github?.category ?? "developer",
    description: "Clone and push private repositories",
    authType: "oauth",
    ...(github?.logoUrl ? { logoUrl: github.logoUrl } : {}),
  };
  const catalog = services.filter(service => service.id !== GITHUB_DEVELOPER_SERVICE_ID);
  return github
    ? catalog.flatMap(service => service === github ? [service, developer] : [service])
    : [...catalog, developer];
}

export function GithubDeveloperAccess({
  identityKey,
  ...props
}: {
  identityKey: string;
  client: GithubDeveloperAccessClient;
  active?: boolean;
  children: (presentation: IntegrationRowPresentation) => ReactNode;
}) {
  return <GithubDeveloperAccessForIdentity key={identityKey} {...props} />;
}

function GithubDeveloperAccessForIdentity({
  client,
  active = true,
  children,
}: {
  client: GithubDeveloperAccessClient;
  active?: boolean;
  children: (presentation: IntegrationRowPresentation) => ReactNode;
}) {
  const [refreshRevision, setRefreshRevision] = useState(0);
  const [status, setStatus] = useState<GithubDeveloperAccessStatus | null>(null);
  const [statusFailed, setStatusFailed] = useState(false);
  const [setupAccess, setSetupAccess] = useState<"checking" | "allowed" | "denied" | "unavailable">("checking");
  const [setupPending, setSetupPending] = useState(false);
  const [setupFailed, setSetupFailed] = useState(false);
  const setupInFlight = useRef(false);

  useEffect(() => {
    if (!active) return;
    const refresh = () => setRefreshRevision((revision) => revision + 1);
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [active]);

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    const { signal } = controller;
    const load = async () => {
      setStatus(null);
      setStatusFailed(false);
      setSetupAccess("checking");
      let parsed: GithubDeveloperAccessStatus | null;
      try {
        parsed = parseGithubDeveloperAccessStatus(await client.status(signal));
      } catch (error: unknown) {
        if (signal.aborted) return;
        console.warn("[github-developer-access] Status unavailable:", error instanceof Error ? error.name : typeof error);
        parsed = null;
      }
      if (signal.aborted) return;
      setStatus(parsed);
      setStatusFailed(parsed === null);
      if (!parsed || parsed.ready) return;
      try {
        const access = await client.setupAccess(signal);
        if (!signal.aborted) {
          const allowed = access.mode === "writable" || access.reason === "runtime_unavailable";
          setSetupAccess(allowed ? "allowed" : "denied");
        }
      } catch (error: unknown) {
        if (signal.aborted) return;
        console.warn("[github-developer-access] Setup permissions unavailable:", error instanceof Error ? error.name : typeof error);
        setSetupAccess("unavailable");
      }
    };
    void load();
    return () => controller.abort();
  }, [active, client, refreshRevision]);

  async function startSetup() {
    if (!active || setupAccess !== "allowed" || setupInFlight.current) return;
    setupInFlight.current = true;
    setSetupPending(true);
    setSetupFailed(false);
    try {
      setSetupFailed(!await client.startSetup());
    } catch (error: unknown) {
      console.warn("[github-developer-access] Setup handoff unavailable:", error instanceof Error ? error.name : typeof error);
      setSetupFailed(true);
    } finally {
      setupInFlight.current = false;
      setSetupPending(false);
    }
  }

  const connectLabel = status?.authenticated ? "Finish setup" : "Connect";
  const retryStatus = statusFailed || setupAccess === "unavailable";
  const ready = status?.ready === true;
  const setupError = setupFailed && !ready && setupAccess === "allowed";
  let detail = "Sign in securely";
  if (statusFailed) detail = "GitHub developer access is unavailable.";
  else if (!status) detail = "Checking developer access…";
  else if (setupAccess === "denied") detail = "Setup requires permission on this computer.";
  else if (setupAccess === "unavailable") detail = "Could not verify setup permission.";
  else if (setupError) detail = "Could not open setup in Terminal.";
  else if (status.authenticated) detail = `${status.user} · ${readinessLabel(status.sshStatus)} · ${identityLabel(status.commitIdentity)}`;

  return children({
    detail,
    detailIsError: retryStatus || setupError,
    ready,
    action: retryStatus || (status && !ready) ? {
      label: retryStatus ? "Retry GitHub Developer status" : setupError ? "Retry GitHub Developer setup" : `${connectLabel} GitHub Developer`,
      text: retryStatus || setupError ? "Retry" : setupPending ? "Opening Terminal…" : connectLabel,
      disabled: !retryStatus && (!active || setupAccess !== "allowed" || setupPending),
      onClick: retryStatus ? () => setRefreshRevision((revision) => revision + 1) : () => void startSetup(),
    } : undefined,
  });
}
