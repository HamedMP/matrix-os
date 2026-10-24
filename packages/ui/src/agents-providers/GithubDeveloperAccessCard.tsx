import { useCallback, useEffect, useState } from "react";

const MAX_ACCOUNT_LABEL_LENGTH = 128;
const MAX_IDENTITY_LABEL_LENGTH = 256;

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

export function GithubDeveloperAccessCard({
  identityKey,
  client,
}: {
  identityKey: string;
  client: GithubDeveloperAccessClient;
}) {
  return <GithubDeveloperAccessCardForIdentity key={identityKey} client={client} />;
}

function GithubDeveloperAccessCardForIdentity({
  client,
}: {
  client: GithubDeveloperAccessClient;
}) {
  const [refreshRevision, setRefreshRevision] = useState(0);
  const [status, setStatus] = useState<GithubDeveloperAccessStatus | null>(null);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [setupPending, setSetupPending] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setStatus(null);
    setPhase("loading");
    void client.status(controller.signal).then((value) => {
      if (controller.signal.aborted) return;
      const parsed = parseGithubDeveloperAccessStatus(value);
      setStatus(parsed);
      setPhase(parsed ? "ready" : "error");
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      console.warn("[github-developer-access] Status unavailable:", error instanceof Error ? error.name : typeof error);
      setStatus(null);
      setPhase("error");
    });
    return () => controller.abort();
  }, [client, refreshRevision]);

  const startSetup = useCallback(async () => {
    if (setupPending) return;
    setSetupPending(true);
    try {
      const opened = await client.startSetup();
      if (!opened) setPhase("error");
    } catch (error: unknown) {
      console.warn("[github-developer-access] Setup handoff unavailable:", error instanceof Error ? error.name : typeof error);
      setPhase("error");
    } finally {
      setSetupPending(false);
    }
  }, [client, setupPending]);

  const connectLabel = status?.authenticated ? "Finish setup" : "Connect";
  return (
    <section className="matrix-ap-github" aria-labelledby="matrix-github-developer-access-title">
      <div className="matrix-ap-panel-head">
        <div>
          <span className="matrix-ap-eyebrow">Developer access</span>
          <h2 id="matrix-github-developer-access-title">GitHub developer access</h2>
          <p>Use this computer to clone private repositories, commit with your identity, push, and open pull requests.</p>
        </div>
        <button type="button" className="matrix-ap-icon-button" aria-label="Refresh GitHub developer access"
          disabled={phase === "loading"} onClick={() => setRefreshRevision((value) => (value + 1) % 1_000_000)}>↻</button>
      </div>
      {phase === "loading" ? <div className="matrix-ap-github-state" role="status">Checking developer access…</div> : null}
      {phase === "error" ? (
        <div className="matrix-ap-notice" data-tone="danger" role="alert">
          <strong>GitHub developer access is unavailable.</strong>
          <span>Refresh to try again, or open setup in Terminal.</span>
        </div>
      ) : null}
      {status ? (
        <>
          <dl className="matrix-ap-github-readiness">
            <div><dt>Account</dt><dd>{status.authenticated ? status.user : "Not connected"}</dd></div>
            <div><dt>SSH</dt><dd>{readinessLabel(status.sshStatus)}</dd></div>
            <div><dt>Commit identity</dt><dd>{identityLabel(status.commitIdentity)}</dd></div>
          </dl>
          <div className="matrix-ap-github-footer">
            <span data-ready={status.ready ? "true" : "false"}>
              {status.ready ? "Ready for private repositories" : "Setup is not complete"}
            </span>
            {!status.ready ? (
              <button type="button" className="matrix-ap-button matrix-ap-button-primary"
                disabled={setupPending} onClick={() => void startSetup()}>{connectLabel}</button>
            ) : null}
          </div>
        </>
      ) : phase === "error" ? (
        <div className="matrix-ap-github-footer">
          <button type="button" className="matrix-ap-button matrix-ap-button-primary"
            disabled={setupPending} onClick={() => void startSetup()}>Connect</button>
        </div>
      ) : null}
    </section>
  );
}
