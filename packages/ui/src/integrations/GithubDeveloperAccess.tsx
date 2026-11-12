import type { ProviderSettingsAccess } from "@matrix-os/contracts";
import type { IntegrationCatalogItem } from "@matrix-os/contracts/integration-marketplace";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "../Button.js";
import { Dialog } from "../Dialog.js";
import { DialogFooter } from "../DialogFooter.js";
import { DialogTitle } from "../DialogTitle.js";
import { GithubDeveloperSetupDialog, useGithubDeveloperSetup, type GithubDeveloperSetupClient } from "./GithubDeveloperSetupDialog.js";
import type { IntegrationRowPresentation } from "./IntegrationMarketplace.js";

const MAX_ACCOUNT_LABEL_LENGTH = 128;
const GITHUB_ACCOUNT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
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

export interface GithubDeveloperAccessClient extends GithubDeveloperSetupClient {
  status(signal: AbortSignal): Promise<unknown>;
  setupAccess(signal: AbortSignal): Promise<ProviderSettingsAccess>;
  startDisconnect?(account: string, signal: AbortSignal): Promise<boolean>;
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

// Match the owner login's canonical gh configuration and ignore inherited tokens.
const githubLogoutScript = [
  'owner_home="$(/usr/bin/realpath "${MATRIX_HOME:-$HOME}")" &&',
  '/usr/bin/env -i HOME="$owner_home" XDG_CONFIG_HOME="$owner_home/.config"',
  'GH_CONFIG_DIR="$owner_home/.config/gh" GH_HOST=github.com',
  'GH_ACCESSIBLE_PROMPTER=1 TERM="${TERM:-xterm-256color}"',
  '/opt/matrix/runtime/node/bin/gh auth logout --hostname github.com --user "$1";',
  'result=$?;',
  "printf '\\nPress Enter to close.\\n';",
  '/usr/bin/timeout --foreground 120 /bin/sh -c "read -r reply";',
  'exit "$result"',
].join(" ");

export function githubDeveloperDisconnectCommand(account: string): string[] | null {
  if (!GITHUB_ACCOUNT_PATTERN.test(account)) return null;
  return ["/bin/sh", "-c", githubLogoutScript, "matrix-github-developer-disconnect", account];
}

export function withGithubDeveloperCatalogEntry(services: readonly IntegrationCatalogItem[]): IntegrationCatalogItem[] {
  const github = services.find(service => service.id === "github");
  const developer: IntegrationCatalogItem = {
    id: GITHUB_DEVELOPER_SERVICE_ID,
    name: "GitHub Developer",
    category: github?.category ?? "developer",
    description: "Set up your GitHub account and SSH key to clone private repos, push commits, and open pull requests.",
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
  const [disconnectPending, setDisconnectPending] = useState(false);
  const [disconnectFailed, setDisconnectFailed] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState<string | null>(null);
  const disconnectInFlight = useRef(false);
  const lifetime = useRef<AbortController | null>(null);
  const refresh = () => setRefreshRevision((revision) => revision + 1);
  const setup = useGithubDeveloperSetup(client, active, refresh);

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    lifetime.current = controller;
    return () => {
      controller.abort();
      lifetime.current = null;
    };
  }, [active, client]);

  useEffect(() => {
    if (!active || setup.pending) return;
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
  }, [active, setup.pending]);

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
      if (!parsed || (parsed.ready && !client.startDisconnect)) return;
      try {
        const access = await client.setupAccess(signal);
        if (!signal.aborted) {
          setSetupAccess(access.mode === "writable" ? "allowed" : "denied");
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

  async function startDisconnect() {
    const signal = lifetime.current?.signal;
    const start = client.startDisconnect;
    if (!signal || signal.aborted || !active || setupAccess !== "allowed" || !status?.ready
      || !confirmDisconnect || confirmDisconnect !== status.user || disconnectInFlight.current || !start) return;
    disconnectInFlight.current = true;
    setDisconnectPending(true);
    setDisconnectFailed(false);
    setConfirmDisconnect(null);
    try {
      const access = await client.setupAccess(signal);
      if (signal.aborted) return;
      if (access.mode !== "writable") {
        setSetupAccess("denied");
        return;
      }
      if (!await start(confirmDisconnect, signal) && !signal.aborted) {
        setDisconnectFailed(true);
        refresh();
      }
    } catch (error: unknown) {
      if (signal.aborted) return;
      console.warn("[github-developer-access] Disconnect handoff unavailable:", error instanceof Error ? error.name : typeof error);
      setDisconnectFailed(true);
      refresh();
    } finally {
      disconnectInFlight.current = false;
      setDisconnectPending(false);
    }
  }

  const connectLabel = status?.authenticated ? "Finish setup" : "Connect";
  const retryStatus = statusFailed || setupAccess === "unavailable";
  const ready = status?.ready === true;
  const canSetup = setupAccess === "allowed" && !disconnectPending;
  const disconnectError = disconnectFailed && ready && setupAccess === "allowed";
  let detail = "Sign in securely";
  if (statusFailed) detail = "GitHub developer access is unavailable.";
  else if (!status) detail = "Checking developer access…";
  else if (setupAccess === "denied" && !ready) detail = "Setup requires permission on this computer.";
  else if (setupAccess === "unavailable") detail = "Could not verify setup permission.";
  else if (disconnectError) detail = "Could not open disconnect in Terminal.";
  else if (status.authenticated) detail = `${status.user} · ${readinessLabel(status.sshStatus)} · ${identityLabel(status.commitIdentity)}`;

  let action: IntegrationRowPresentation["action"];
  let accountAction: IntegrationRowPresentation["accountAction"];
  if (retryStatus || (status && !ready)) {
    action = {
      label: retryStatus ? "Retry GitHub Developer status" : `${connectLabel} GitHub Developer`,
      text: retryStatus ? "Retry" : setup.pending ? "Connecting…" : connectLabel,
      disabled: !active || (!retryStatus && (!canSetup || setup.pending || !!setup.view)),
      onClick: retryStatus ? refresh : () => { if (canSetup) void setup.start(); },
    };
  } else if (ready && status.user && GITHUB_ACCOUNT_PATTERN.test(status.user)
    && setupAccess === "allowed" && client.startDisconnect) {
    accountAction = {
      label: disconnectError ? "Retry GitHub Developer disconnect" : "Disconnect GitHub Developer",
      text: disconnectPending ? "Opening Terminal…" : disconnectError ? "Retry" : "Disconnect",
      disabled: !active || disconnectPending || setup.pending,
      onClick: () => setConfirmDisconnect(status?.user ?? null),
    };
  }

  return (
    <>
      {children({ detail, detailIsError: retryStatus || disconnectError, ready, action, accountAction })}
      <GithubDeveloperSetupDialog setup={setup} openPage={client.openSetupPage} canStart={canSetup} />
      {active && ready && setupAccess === "allowed" && confirmDisconnect && confirmDisconnect === status?.user ? (
        <Dialog open onClose={() => setConfirmDisconnect(null)} aria-label="Disconnect GitHub Developer?">
          <DialogTitle>Disconnect GitHub Developer?</DialogTitle>
          <p className="text-sm">This signs {confirmDisconnect} out of GitHub CLI on this computer. Existing SSH keys and Git commit identity are preserved.</p>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setConfirmDisconnect(null)} autoFocus>Cancel</Button>
            <Button variant="destructive" onClick={() => void startDisconnect()}>Disconnect</Button>
          </DialogFooter>
        </Dialog>
      ) : null}
    </>
  );
}
