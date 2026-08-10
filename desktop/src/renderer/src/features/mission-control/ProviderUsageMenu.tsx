import type {
  ProviderUsageSourceSummary,
  ProviderUsageWindow,
  SafeSetupAction,
} from "@matrix-os/contracts";
import * as Popover from "@radix-ui/react-popover";
import { CircleDollarSign, Gauge, LoaderCircle, RefreshCw } from "lucide-react";
import { useMemo, useState } from "react";
import { useProviderPreferences } from "../settings/provider-preferences";
import { ProviderGlyph } from "../settings/provider-glyph";
import { openProviderSetupTerminal, providerSetupCommands } from "../coding-agents/provider-setup-terminal";
import { useCodingAgentWorkspace } from "../../stores/coding-agent-workspace";
import { useConnection } from "../../stores/connection";
import {
  lowestRemainingWindow,
  selectUsageSource,
  useProviderUsage,
} from "../../stores/provider-usage";
import { useTabs } from "../../stores/tabs";

const SETUP_ERROR = "Could not open setup terminal. Try again from Terminal.";

type UsageTone = "accent" | "warning" | "danger";

const SOURCE_STATE_COPY = {
  available: "Available",
  stale: "Last known",
  setup_required: "Setup required",
  unavailable: "Temporarily unavailable",
  unsupported: "Usage not reported",
} as const;

function formatPercent(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, "");
}

function usageTone(remainingPercent: number): UsageTone {
  if (remainingPercent < 10) return "danger";
  if (remainingPercent <= 20) return "warning";
  return "accent";
}

function toneColor(tone: UsageTone): string {
  return `var(--${tone})`;
}

function relativeTime(targetIso: string, baseIso: string): string | null {
  const target = Date.parse(targetIso);
  const base = Date.parse(baseIso);
  if (!Number.isFinite(target) || !Number.isFinite(base)) return null;
  const deltaSeconds = (target - base) / 1_000;
  const absoluteSeconds = Math.abs(deltaSeconds);
  const [divisor, unit] = absoluteSeconds >= 86_400
    ? [86_400, "day" as const]
    : absoluteSeconds >= 3_600
      ? [3_600, "hour" as const]
      : absoluteSeconds >= 60
        ? [60, "minute" as const]
        : [1, "second" as const];
  return new Intl.RelativeTimeFormat("en", { numeric: "auto" }).format(
    Math.round(deltaSeconds / divisor),
    unit,
  );
}

function resetCopy(window: ProviderUsageWindow, serverTime: string): string | null {
  if (!window.resetsAt) return null;
  const relative = relativeTime(window.resetsAt, serverTime);
  return relative ? `Resets ${relative}` : null;
}

function freshnessCopy(source: ProviderUsageSourceSummary, serverTime: string): string | null {
  if (!source.observedAt) return null;
  const relative = relativeTime(source.observedAt, serverTime);
  if (!relative) return null;
  return `Updated ${relative === "now" ? "just now" : relative}`;
}

function absoluteTime(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  const timestamp = Date.parse(iso);
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString() : undefined;
}

function creditsCopy(source: ProviderUsageSourceSummary): string | null {
  if (!source.credits) return null;
  if (source.credits.unit === "USD") {
    return `${new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(source.credits.remaining)} remaining`;
  }
  return `${source.credits.remaining.toLocaleString("en-US")} ${source.credits.unit} remaining`;
}

function ProgressRing({ remainingPercent }: { remainingPercent: number }) {
  const bounded = Math.max(0, Math.min(100, remainingPercent));
  const tone = usageTone(bounded);
  const radius = 8;
  const circumference = 2 * Math.PI * radius;
  return (
    <svg
      role="progressbar"
      aria-label={`${formatPercent(remainingPercent)}% remaining`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={remainingPercent}
      data-tone={tone}
      viewBox="0 0 20 20"
      className="h-6 w-6 shrink-0 -rotate-90"
      style={{ color: toneColor(tone) }}
    >
      <circle cx="10" cy="10" r={radius} fill="none" stroke="var(--border-default)" strokeWidth="2.5" />
      <circle
        cx="10"
        cy="10"
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="2.5"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - bounded / 100)}
      />
    </svg>
  );
}

function sourceProvider(
  source: ProviderUsageSourceSummary | null,
  providers: NonNullable<ReturnType<typeof useCodingAgentWorkspace.getState>["summary"]>["providers"],
) {
  if (!source) return null;
  const matches = providers.filter((provider) => source.linkedAgentProviderIds.includes(provider.id));
  return matches.length === 1 ? matches[0]! : null;
}

function compactStatus(
  source: ProviderUsageSourceSummary | null,
  window: ProviderUsageWindow | null,
  storeStatus: ReturnType<typeof useProviderUsage.getState>["status"],
): string {
  if (source && window) {
    const remaining = `${formatPercent(window.remainingPercent)}% left`;
    return source.state === "stale" || storeStatus === "error"
      ? `${remaining} · Last known`
      : remaining;
  }
  if (source) return SOURCE_STATE_COPY[source.state];
  if (storeStatus === "loading" || storeStatus === "idle") return "Checking usage…";
  if (storeStatus === "error") return "Usage temporarily unavailable";
  return "Usage not reported";
}

function sourceAccuracy(source: ProviderUsageSourceSummary): string | null {
  if (source.accuracy === "provider_reported") return "Provider reported";
  if (source.accuracy === "provider_derived") return "Provider derived";
  return null;
}

function SetupActionButton({
  source,
  action,
  onError,
}: {
  source: ProviderUsageSourceSummary;
  action: SafeSetupAction;
  onError: () => void;
}) {
  const api = useConnection((state) => state.api);
  const openTab = useTabs((state) => state.openTab);

  return (
    <button
      type="button"
      className="rounded-md px-2 py-1 text-[11px] font-medium outline-none hover:bg-[var(--bg-hover)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
      style={{ color: "var(--accent)", border: "1px solid var(--border-subtle)" }}
      onClick={() => {
        if (action.kind === "open_settings") {
          openTab({ kind: "settings", title: "Settings" });
          return;
        }
        if (!api) {
          onError();
          return;
        }
        const setup = providerSetupCommands([{ id: source.id, setupActions: [action] }])[0];
        if (!setup) {
          onError();
          return;
        }
        void openProviderSetupTerminal(api, setup, openTab, "provider-usage").then((opened) => {
          if (!opened) onError();
        });
      }}
    >
      {action.label}
    </button>
  );
}

function UsageSourceCard({
  source,
  serverTime,
  lastKnown,
}: {
  source: ProviderUsageSourceSummary;
  serverTime: string;
  lastKnown: boolean;
}) {
  const summary = useCodingAgentWorkspace((state) => state.summary);
  const provider = summary ? sourceProvider(source, summary.providers) : null;
  const [setupError, setSetupError] = useState(false);
  const freshness = freshnessCopy(source, serverTime);
  const accuracy = sourceAccuracy(source);

  return (
    <section className="rounded-lg border p-2.5" style={{ borderColor: "var(--border-subtle)", background: "var(--bg-surface)" }}>
      <div className="flex items-start gap-2">
        {provider ? <ProviderGlyph kind={provider.kind} /> : (
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg" style={{ background: "var(--accent-muted)", color: "var(--accent)" }}>
            <Gauge size={16} aria-hidden="true" />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <h3 className="truncate text-xs font-semibold" style={{ color: "var(--text-primary)" }}>{source.displayName}</h3>
            {lastKnown ? (
              <span className="rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide" style={{ color: "var(--warning)", background: "var(--warning-muted)" }}>Last known</span>
            ) : null}
          </div>
          {provider ? <p className="text-[10px]" style={{ color: "var(--text-tertiary)" }}>Used by {provider.displayName}</p> : null}
        </div>
      </div>

      {source.windows.length > 0 ? (
        <div className="mt-2 flex flex-col gap-1.5">
          {source.windows.map((window) => {
            const tone = usageTone(window.remainingPercent);
            const reset = resetCopy(window, serverTime);
            return (
              <div key={window.id} className="rounded-md px-2 py-1.5" style={{ background: "var(--bg-hover)" }}>
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-[11px]" style={{ color: "var(--text-secondary)" }}>{window.label}</span>
                  <span className="text-xs font-semibold tabular-nums" style={{ color: toneColor(tone) }}>{formatPercent(window.remainingPercent)}% left</span>
                </div>
                {reset ? (
                  <p className="mt-0.5 text-[10px]" title={absoluteTime(window.resetsAt)} style={{ color: "var(--text-tertiary)" }}>{reset}</p>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : (
        <p className="mt-2 text-xs" style={{ color: source.state === "unavailable" ? "var(--danger)" : source.state === "setup_required" ? "var(--warning)" : "var(--text-secondary)" }}>
          {SOURCE_STATE_COPY[source.state]}
        </p>
      )}

      {source.credits ? (
        <p className="mt-2 flex items-center gap-1.5 text-[11px]" style={{ color: "var(--text-secondary)" }}>
          <CircleDollarSign size={12} aria-hidden="true" /> {creditsCopy(source)}
        </p>
      ) : null}

      {freshness || accuracy ? (
        <p className="mt-2 text-[10px]" title={absoluteTime(source.observedAt)} style={{ color: "var(--text-tertiary)" }}>
          {[freshness, accuracy].filter(Boolean).join(" · ")}
        </p>
      ) : null}

      {source.setupActions.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {source.setupActions.map((action) => (
            <SetupActionButton key={action.id} source={source} action={action} onError={() => setSetupError(true)} />
          ))}
        </div>
      ) : null}
      {setupError ? <p className="mt-2 text-[10px]" style={{ color: "var(--danger)" }}>{SETUP_ERROR}</p> : null}
    </section>
  );
}

export default function ProviderUsageMenu({ collapsed }: { collapsed: boolean }) {
  const summary = useCodingAgentWorkspace((state) => state.summary);
  const activeThreadId = useCodingAgentWorkspace((state) => state.activeThreadId);
  const defaultProviderId = useProviderPreferences((state) => state.defaultProviderId);
  const status = useProviderUsage((state) => state.status);
  const response = useProviderUsage((state) => state.response);
  const refresh = useProviderUsage((state) => state.refresh);
  const [open, setOpen] = useState(false);

  const capabilityEnabled = summary?.capabilities.some(
    (capability) => capability.id === "codingAgentsUsageSummary" && capability.enabled,
  ) ?? false;
  const selectedSource = useMemo(
    () => selectUsageSource(response, summary, activeThreadId, defaultProviderId),
    [activeThreadId, defaultProviderId, response, summary],
  );
  const selectedWindow = useMemo(() => lowestRemainingWindow(selectedSource), [selectedSource]);
  const provider = summary ? sourceProvider(selectedSource, summary.providers) : null;
  const providerLabel = provider?.displayName ?? selectedSource?.displayName ?? "Provider usage";
  const statusCopy = compactStatus(selectedSource, selectedWindow, status);
  const selectedLastKnown = selectedSource?.state === "stale" || status === "error";
  const reset = selectedWindow && response ? resetCopy(selectedWindow, response.serverTime) : null;
  const freshness = selectedSource && response ? freshnessCopy(selectedSource, response.serverTime) : null;
  const ariaLabel = [
    providerLabel,
    statusCopy,
    reset?.toLowerCase(),
    freshness?.toLowerCase(),
  ].filter(Boolean).join(", ");

  if (!capabilityEnabled) return null;

  return (
    <Popover.Root
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (nextOpen) void refresh();
      }}
    >
      <div className="px-2 py-1">
        <Popover.Trigger asChild>
          <button
            type="button"
            aria-label={ariaLabel}
            aria-haspopup="dialog"
            className={`flex h-9 w-full items-center rounded-md outline-none transition-colors hover:bg-[var(--bg-hover)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${collapsed ? "justify-center" : "gap-2 px-2"}`}
            title={collapsed ? ariaLabel : undefined}
          >
            {selectedWindow && !selectedLastKnown ? <ProgressRing remainingPercent={selectedWindow.remainingPercent} /> : (
              <span className="flex h-6 w-6 shrink-0 items-center justify-center" style={{ color: status === "loading" || status === "refreshing" ? "var(--accent)" : "var(--text-tertiary)" }}>
                {status === "loading" || status === "refreshing"
                  ? <LoaderCircle size={15} className="animate-spin" aria-hidden="true" />
                  : <Gauge size={15} aria-hidden="true" />}
              </span>
            )}
            {!collapsed ? (
              <span className="min-w-0 flex-1 text-left leading-tight">
                <span className="block truncate text-xs font-medium" style={{ color: "var(--text-primary)" }}>{providerLabel}</span>
                <span className="block truncate text-[10px]" style={{ color: selectedLastKnown ? "var(--warning)" : "var(--text-tertiary)" }}>{statusCopy}</span>
              </span>
            ) : null}
          </button>
        </Popover.Trigger>
      </div>

      <Popover.Portal>
        <Popover.Content
          role="dialog"
          aria-label="Provider usage"
          side="top"
          align={collapsed ? "start" : "center"}
          sideOffset={6}
          collisionPadding={12}
          className="z-50 w-[min(360px,calc(100vw-24px))] rounded-xl border p-2.5 shadow-xl outline-none"
          style={{ borderColor: "var(--border-default)", background: "var(--bg-overlay)" }}
        >
          <div className="mb-2 flex items-center justify-between gap-2 px-0.5">
            <div>
              <h2 className="text-xs font-semibold" style={{ color: "var(--text-primary)" }}>Provider usage</h2>
              <p className="text-[10px]" style={{ color: "var(--text-tertiary)" }}>Exact usage reported by each account source</p>
            </div>
            <button
              type="button"
              aria-label="Refresh usage"
              disabled={status === "loading" || status === "refreshing"}
              className="rounded-md p-1.5 outline-none hover:bg-[var(--bg-hover)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-40"
              style={{ color: "var(--text-secondary)" }}
              onClick={() => void refresh({ force: true })}
            >
              <RefreshCw size={13} className={status === "loading" || status === "refreshing" ? "animate-spin" : ""} aria-hidden="true" />
            </button>
          </div>

          <div className="max-h-[min(420px,70vh)] space-y-2 overflow-y-auto">
            {response?.usageSources.map((source) => (
              <UsageSourceCard
                key={source.id}
                source={source}
                serverTime={response.serverTime}
                lastKnown={source.state === "stale" || status === "error"}
              />
            ))}
            {!response || response.usageSources.length === 0 ? (
              <p className="px-1 py-4 text-center text-xs" style={{ color: "var(--text-secondary)" }}>{compactStatus(null, null, status)}</p>
            ) : null}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
