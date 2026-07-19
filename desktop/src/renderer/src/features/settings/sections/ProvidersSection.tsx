// Providers settings page: one card per coding-agent provider reported by the
// runtime, with status, the existing foreground-terminal setup flow, and the
// default-provider preference for new chats. Status refreshes on open and on
// runtime switches; a failed refresh keeps the last good snapshot visible
// (stale-while-revalidate) and only ever shows generic, allowlisted copy.
import type { AgentProviderSummary, RuntimeSummary } from "@matrix-os/contracts";
import { RefreshCw, SquareTerminal } from "lucide-react";
import { useEffect, useState } from "react";
import { Button, StatusDot } from "../../../design/primitives";
import { invoke } from "../../../lib/operator";
import { useConnection } from "../../../stores/connection";
import { useTabs } from "../../../stores/tabs";
import {
  openProviderSetupTerminal,
  providerSetupCommands,
  type ProviderSetupCommand,
} from "../../coding-agents/provider-setup-terminal";
import { ProviderGlyph } from "../provider-glyph";
import { useProviderPreferences } from "../provider-preferences";
import { Card, Empty, SectionHeader } from "./section-kit";

const PROVIDER_STATUS_COLOR: Record<AgentProviderSummary["availability"], string> = {
  available: "var(--success)",
  setup_required: "var(--warning)",
  auth_required: "var(--warning)",
  installing: "var(--accent)",
  unavailable: "var(--danger)",
  unknown: "var(--text-tertiary)",
};

const STATUS_UNAVAILABLE_ERROR = "Provider status is unavailable right now.";
const SETUP_TERMINAL_ERROR = "Could not open setup terminal. Try again from Terminal.";
const OFFLINE_MESSAGE = "Connect to your Matrix computer to manage coding agent providers.";

function titleCaseStatus(value: string): string {
  const label = value.replace(/_/g, " ");
  return `${label.charAt(0).toUpperCase()}${label.slice(1)}`;
}

function providerStatusLine(provider: AgentProviderSummary): string {
  return `${titleCaseStatus(provider.availability)} · ${provider.installStatus} / ${provider.authStatus}`;
}

function ProviderCard({
  provider,
  isDefault,
  onOpenSetup,
}: {
  provider: AgentProviderSummary;
  isDefault: boolean;
  onOpenSetup: (setup: ProviderSetupCommand) => void;
}) {
  const setupCommands = providerSetupCommands([provider]);
  return (
    <Card>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <ProviderGlyph kind={provider.kind} />
          <div className="flex min-w-0 flex-col gap-0.5">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-medium" style={{ color: "var(--text-primary)" }}>
                {provider.displayName}
              </span>
              {isDefault ? (
                <span
                  className="rounded-full px-2 py-0.5 text-[11px] font-medium"
                  style={{ background: "var(--accent-muted)", color: "var(--accent)" }}
                >
                  Default
                </span>
              ) : null}
            </div>
            <span className="text-xs" style={{ color: "var(--text-tertiary)" }}>
              {providerStatusLine(provider)}
            </span>
            {provider.defaultModel ? (
              <span className="text-xs" style={{ color: "var(--text-tertiary)" }}>
                Model: {provider.defaultModel}
              </span>
            ) : null}
          </div>
        </div>
        <StatusDot color={PROVIDER_STATUS_COLOR[provider.availability]} />
      </div>
      {setupCommands.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          {setupCommands.map((setup) => (
            <Button
              key={setup.key}
              variant="subtle"
              aria-label={`Open provider setup ${setup.label}`}
              onClick={() => onOpenSetup(setup)}
            >
              <SquareTerminal size={13} />
              {setup.label}
            </Button>
          ))}
        </div>
      ) : null}
    </Card>
  );
}

export default function ProvidersSection() {
  const api = useConnection((s) => s.api);
  const runtimeSlot = useConnection((s) => s.runtimeSlot);
  const openTab = useTabs((s) => s.openTab);
  const defaultProviderId = useProviderPreferences((s) => s.defaultProviderId);
  const hydratePreferences = useProviderPreferences((s) => s.hydrate);
  const setDefaultProvider = useProviderPreferences((s) => s.setDefaultProvider);

  const [summary, setSummary] = useState<RuntimeSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [reloadSeq, setReloadSeq] = useState(0);

  useEffect(() => {
    void hydratePreferences();
  }, [hydratePreferences]);

  useEffect(() => {
    if (!api) {
      // A dropped session also invalidates any cached snapshot from the
      // previous identity; never show one user's providers to the next.
      setSummary(null);
      setError(null);
      setSetupError(null);
      setRefreshing(false);
      return;
    }
    let cancelled = false;
    setRefreshing(true);
    invoke("runtime:get-summary", {})
      .then((nextSummary) => {
        if (cancelled) return;
        setSummary(nextSummary);
        setError(null);
      })
      .catch((err: unknown) => {
        console.error(
          "[settings] Failed to load provider status:",
          err instanceof Error ? err.name : typeof err,
        );
        if (!cancelled) setError(STATUS_UNAVAILABLE_ERROR);
      })
      .finally(() => {
        if (!cancelled) setRefreshing(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api, runtimeSlot, reloadSeq]);

  const retry = () => setReloadSeq((seq) => seq + 1);

  const openSetup = async (setup: ProviderSetupCommand) => {
    setSetupError(null);
    if (!api) {
      setSetupError(OFFLINE_MESSAGE);
      return;
    }
    const opened = await openProviderSetupTerminal(api, setup, openTab, "settings-providers");
    if (!opened) setSetupError(SETUP_TERMINAL_ERROR);
  };

  const providers = summary?.providers ?? [];
  const unknownDefault =
    defaultProviderId && !providers.some((provider) => provider.id === defaultProviderId)
      ? defaultProviderId
      : null;

  return (
    <>
      <div className="flex items-start justify-between gap-4">
        <SectionHeader
          title="Providers"
          description="Coding agents on this computer. Install, sign in, and choose the default for new chats."
        />
        <Button
          variant="subtle"
          aria-label="Refresh provider status"
          disabled={!api || refreshing}
          onClick={retry}
        >
          <RefreshCw size={13} className={refreshing ? "animate-spin" : ""} />
          {refreshing ? "Refreshing" : "Refresh"}
        </Button>
      </div>

      {!api ? (
        <Card>
          <Empty text={OFFLINE_MESSAGE} />
          <div>
            <Button variant="subtle" onClick={retry}>
              Retry
            </Button>
          </div>
        </Card>
      ) : (
        <>
          {providers.length > 0 ? (
            <Card>
              <span className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>
                Default provider
              </span>
              <span className="text-xs" style={{ color: "var(--text-secondary)" }}>
                New agent chats start with this provider when it is ready.
              </span>
              <select
                aria-label="Default provider"
                className="h-8 w-full max-w-[320px] rounded-md border px-2 text-sm outline-none"
                style={{
                  borderColor: "var(--border-subtle)",
                  background: "var(--bg-overlay)",
                  color: "var(--text-primary)",
                }}
                value={defaultProviderId ?? ""}
                onChange={(event) =>
                  setDefaultProvider(event.target.value === "" ? null : event.target.value)
                }
              >
                <option value="">Automatic (first ready provider)</option>
                {providers.map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {provider.displayName}
                  </option>
                ))}
                {unknownDefault ? (
                  <option value={unknownDefault}>{unknownDefault} (not available)</option>
                ) : null}
              </select>
            </Card>
          ) : null}

          {setupError ? (
            <span className="mb-4 block text-xs" style={{ color: "var(--danger)" }}>
              {setupError}
            </span>
          ) : null}

          {error ? (
            <Card>
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm" style={{ color: "var(--danger)" }}>
                  {error}
                </span>
                <Button variant="subtle" onClick={retry}>
                  Retry
                </Button>
              </div>
            </Card>
          ) : null}

          {!summary && !error ? (
            <Card>
              <Empty text="Checking provider status…" />
            </Card>
          ) : null}

          {summary && providers.length === 0 ? (
            <Card>
              <Empty text="No coding agent providers are configured on this computer yet." />
            </Card>
          ) : null}

          {providers.map((provider) => (
            <ProviderCard
              key={provider.id}
              provider={provider}
              isDefault={provider.id === defaultProviderId}
              onOpenSetup={(setup) => void openSetup(setup)}
            />
          ))}
        </>
      )}
    </>
  );
}
