import type { ProviderSettingsAccess } from "@matrix-os/contracts";
import { Github } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

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

const muted = { color: "var(--text-tertiary, var(--muted-foreground))" };
const pill = { background: "var(--bg-surface-hover, var(--muted))" };
const success = { color: "var(--surface-success-emphasis, var(--primary))" };
const danger = { color: "var(--surface-danger-emphasis, var(--destructive))" };

export function GithubDeveloperAccessCard({
  identityKey,
  client,
  active = true,
}: {
  identityKey: string;
  client: GithubDeveloperAccessClient;
  active?: boolean;
}) {
  return <GithubDeveloperAccessCardForIdentity key={identityKey} client={client} active={active} />;
}

function GithubDeveloperAccessCardForIdentity({
  client,
  active,
}: {
  client: GithubDeveloperAccessClient;
  active: boolean;
}) {
  const titleId = useId();
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
  return (
    <section className="flex min-w-0 flex-wrap items-center gap-3 py-4" aria-labelledby={titleId}>
      <div className="flex size-12 shrink-0 items-center justify-center rounded-xl" style={pill}>
        <Github size={24} aria-hidden="true" />
      </div>
      <div className="min-w-0 flex-1 basis-32">
        <h3 id={titleId} className="font-sans text-sm font-medium">GitHub Developer</h3>
        <p className="mt-1 text-sm" style={muted}>Clone and push private repositories from this computer.</p>
        {!status && !statusFailed ? (
          <p className="mt-1 text-xs" style={muted} role="status">Checking developer access…</p>
        ) : null}
        {status?.authenticated ? (
          <p className="mt-1 break-words text-xs" style={muted}>
            {status.user} · {readinessLabel(status.sshStatus)} · {identityLabel(status.commitIdentity)}
          </p>
        ) : null}
        {statusFailed ? (
          <p className="mt-1 text-xs" style={danger} role="alert">GitHub developer access is unavailable.</p>
        ) : null}
        {status && !status.ready && setupAccess === "denied" ? (
          <p className="mt-1 text-xs" style={muted}>Setup requires permission on this computer.</p>
        ) : null}
        {setupAccess === "unavailable" ? (
          <p className="mt-1 text-xs" style={danger} role="alert">Could not verify setup permission.</p>
        ) : null}
        {setupFailed && status && !status.ready && setupAccess === "allowed" ? (
          <p className="mt-1 text-xs" style={danger} role="alert">Could not open setup in Terminal.</p>
        ) : null}
      </div>
      {status?.ready ? (
        <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium"
          style={{ ...success, background: "color-mix(in srgb, var(--surface-success-emphasis, var(--primary)) 12%, transparent)" }}
          role="status">
          <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />
          Ready
        </span>
      ) : null}
      {retryStatus || (status && !status.ready) ? (
        <button type="button" className="shrink-0 rounded-full px-4 py-2 text-sm transition-opacity hover:opacity-75 disabled:opacity-50 focus-visible:outline-2"
          style={pill}
          aria-label={retryStatus ? "Retry GitHub Developer status" : setupFailed ? "Retry GitHub Developer setup" : `${connectLabel} GitHub Developer`}
          disabled={!retryStatus && (setupAccess !== "allowed" || setupPending)}
          onClick={retryStatus ? () => setRefreshRevision((revision) => revision + 1) : () => void startSetup()}>
          {retryStatus || setupFailed ? "Retry" : setupPending ? "Opening Terminal…" : connectLabel}
        </button>
      ) : null}
    </section>
  );
}
