import type {
  AgentProviderDescriptor,
  AgentRuntimeId,
  AgentSettingsView,
} from "@matrix-os/contracts";
import { KeyRound, Radio, SquareTerminal } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button, StatusDot } from "../../../design/primitives";
import { normalizeAgentConfig } from "../../../lib/agent-config";
import { toUserMessage } from "../../../lib/errors";
import { useConnection } from "../../../stores/connection";
import { useTabs } from "../../../stores/tabs";
import {
  openProviderSetupTerminal,
  type ProviderSetupCommand,
} from "../../coding-agents/provider-setup-terminal";
import { Card, Empty } from "./section-kit";

const AGENT_PATH = "/api/settings/agent";
const API_KEY_PATH = "/api/settings/api-key";
const LOAD_ERROR = "Agent runtime settings are unavailable.";
const UPDATE_ERROR = "Agent settings could not be updated.";
const SETUP_ERROR = "Could not open setup terminal. Try again from Terminal.";

const RUNTIME_SETUP: Record<AgentRuntimeId, ProviderSetupCommand> = {
  hermes: {
    key: "hermes:model",
    label: "Hermes provider setup",
    command: "hermes model",
    sessionName: "matrix-setup-hermes-model",
  },
  openclaw: {
    key: "openclaw:model-auth",
    label: "OpenClaw provider setup",
    command: "openclaw models auth add",
    sessionName: "matrix-setup-openclaw-auth",
  },
};

const CLAUDE_SETUP: ProviderSetupCommand = {
  key: "claude:login",
  label: "Claude login",
  command: "claude",
  sessionName: "matrix-setup-claude-login",
};

function statusLabel(value: string): string {
  return value
    .split("_")
    .map((part) => part.length > 0 ? `${part[0]?.toUpperCase()}${part.slice(1)}` : part)
    .join(" ");
}

function statusColor(value: string): string {
  if (value === "healthy" || value === "ready" || value === "active") return "var(--success)";
  if (value === "installing" || value === "validating" || value === "activating") return "var(--accent)";
  if (value === "degraded" || value === "action_required" || value === "stopped") return "var(--warning)";
  if (value === "unavailable" || value === "unreachable" || value === "failed") return "var(--danger)";
  return "var(--text-tertiary)";
}

function availableModels(provider: AgentProviderDescriptor | undefined) {
  return provider?.models.filter((model) => model.available) ?? [];
}

function AuthStatus({ provider }: { provider: AgentProviderDescriptor }) {
  return (
    <span className="flex items-center gap-1.5 text-xs" style={{ color: "var(--text-tertiary)" }}>
      <StatusDot color={statusColor(provider.authStatus.state)} />
      {statusLabel(provider.authStatus.state)} · {statusLabel(provider.authKind)}
    </span>
  );
}

function RuntimeOptions({
  view,
  busy,
  onSwitch,
}: {
  view: AgentSettingsView;
  busy: boolean;
  onSwitch: (runtime: AgentRuntimeId) => void;
}) {
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      {view.runtime.options.map((runtime) => {
        const selected = runtime.id === view.runtime.selected;
        const usable = runtime.installState === "installed"
          && runtime.selectionState !== "unavailable";
        return (
          <article
            key={runtime.id}
            className="rounded-lg border p-3"
            style={{
              borderColor: selected ? "var(--accent)" : "var(--border-subtle)",
              background: selected ? "var(--accent-subtle)" : "var(--bg-sunken)",
            }}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <span className="block truncate text-sm font-medium" style={{ color: "var(--text-primary)" }}>
                  {runtime.displayName}
                </span>
                <span className="text-xs" style={{ color: "var(--text-tertiary)" }}>
                  {runtime.version ? `Version ${runtime.version}` : statusLabel(runtime.installState)}
                </span>
              </div>
              <span className="flex items-center gap-1.5 text-xs" style={{ color: "var(--text-secondary)" }}>
                <StatusDot color={statusColor(runtime.health)} />
                {statusLabel(runtime.health)}
              </span>
            </div>
            <div className="mt-3">
              {selected ? (
                <span className="text-xs font-medium" style={{ color: "var(--success)" }}>
                  {runtime.displayName} is active
                </span>
              ) : (
                <Button
                  variant="subtle"
                  disabled={busy || !usable}
                  aria-label={`Use ${runtime.displayName}`}
                  onClick={() => onSwitch(runtime.id)}
                >
                  {usable ? `Use ${runtime.displayName}` : "Runtime update needed"}
                </Button>
              )}
            </div>
          </article>
        );
      })}
    </div>
  );
}

function ChatAuthentication({
  view,
  busy,
  onSaveKey,
  onOpenSetup,
}: {
  view: AgentSettingsView;
  busy: boolean;
  onSaveKey: (key: string) => Promise<void>;
  onOpenSetup: (setup: ProviderSetupCommand) => Promise<void>;
}) {
  const provider = view.providers.find((candidate) =>
    candidate.runtime === null && candidate.scopes.includes("chat"));
  const [showKey, setShowKey] = useState(false);
  const [apiKey, setApiKey] = useState("");

  if (!provider) return null;

  const saveKey = async () => {
    const key = apiKey;
    setApiKey("");
    await onSaveKey(key);
  };

  return (
    <div className="rounded-lg border p-3" style={{ borderColor: "var(--border-subtle)", background: "var(--bg-sunken)" }}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <span className="block text-sm font-medium" style={{ color: "var(--text-primary)" }}>{provider.displayName}</span>
          <AuthStatus provider={provider} />
        </div>
        <div className="flex flex-wrap gap-2">
          {provider.supportedAuthKinds.includes("api_key") ? (
            <Button variant="subtle" onClick={() => setShowKey((value) => !value)}>
              <KeyRound size={13} />Use my API key
            </Button>
          ) : null}
          {provider.supportedAuthKinds.includes("oauth_login") ? (
            <Button variant="subtle" onClick={() => void onOpenSetup(CLAUDE_SETUP)}>
              <SquareTerminal size={13} />Sign in with Claude
            </Button>
          ) : null}
        </div>
      </div>
      {showKey ? (
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <label className="min-w-48 flex-1 text-xs" style={{ color: "var(--text-secondary)" }}>
            Anthropic API key
            <input
              className="mt-1 h-8 w-full rounded-md border bg-transparent px-2 text-sm outline-none"
              style={{ borderColor: "var(--border-default)", color: "var(--text-primary)" }}
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
            />
          </label>
          <Button variant="primary" disabled={busy || apiKey.length < 8} onClick={() => void saveKey()}>
            Save API key
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function MessagingProvider({
  view,
  busy,
  onSave,
  onOpenSetup,
}: {
  view: AgentSettingsView;
  busy: boolean;
  onSave: (provider: string, model: string) => void;
  onOpenSetup: (setup: ProviderSetupCommand) => Promise<void>;
}) {
  const providers = useMemo(() => view.providers.filter((candidate) =>
    candidate.runtime === view.runtime.selected && candidate.scopes.includes("messaging")), [view]);
  const current = view.currentSelection.messaging;
  const [providerId, setProviderId] = useState(current.provider ?? providers[0]?.id ?? "");
  const provider = providers.find((candidate) => candidate.id === providerId);
  const [model, setModel] = useState(current.model ?? availableModels(provider)[0]?.id ?? "");

  if (providers.length === 0) {
    return <Empty text="No providers are available for the selected messaging runtime." />;
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border p-3" style={{ borderColor: "var(--border-subtle)", background: "var(--bg-sunken)" }}>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {providers.map((candidate) => (
          <button
            key={candidate.id}
            type="button"
            className="rounded-md border p-2 text-left"
            style={{
              borderColor: candidate.id === providerId ? "var(--accent)" : "var(--border-default)",
              background: candidate.id === providerId ? "var(--accent-subtle)" : "transparent",
            }}
            aria-label={`Choose ${candidate.displayName}`}
            aria-pressed={candidate.id === providerId}
            onClick={() => {
              setProviderId(candidate.id);
              setModel(availableModels(candidate)[0]?.id ?? "");
            }}
          >
            <span className="block text-sm font-medium" style={{ color: "var(--text-primary)" }}>{candidate.displayName}</span>
            <AuthStatus provider={candidate} />
          </button>
        ))}
      </div>
      <label className="text-xs" style={{ color: "var(--text-secondary)" }}>
        Messaging model
        <select
          className="mt-1 h-8 w-full rounded-md border bg-transparent px-2 text-sm outline-none"
          style={{ borderColor: "var(--border-default)", color: "var(--text-primary)" }}
          aria-label="Messaging model"
          value={model}
          onChange={(event) => setModel(event.target.value)}
        >
          {availableModels(provider).map((candidate) => (
            <option key={candidate.id} value={candidate.id}>{candidate.displayName}</option>
          ))}
        </select>
      </label>
      <div className="flex flex-wrap justify-end gap-2">
        <Button
          variant="subtle"
          aria-label={`Configure ${statusLabel(view.runtime.selected)} provider`}
          onClick={() => void onOpenSetup(RUNTIME_SETUP[view.runtime.selected])}
        >
          <SquareTerminal size={13} />Configure
        </Button>
        <Button variant="primary" disabled={busy || !providerId || !model} onClick={() => onSave(providerId, model)}>
          Save messaging model
        </Button>
      </div>
    </div>
  );
}

export default function AgentRuntimeSettingsCard() {
  const api = useConnection((state) => state.api);
  const openTab = useTabs((state) => state.openTab);
  const [view, setView] = useState<AgentSettingsView | null>(null);
  const [legacy, setLegacy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    if (!api) return;
    const config = normalizeAgentConfig(await api.get<unknown>(AGENT_PATH));
    setView(config.extended);
    setLegacy(config.runtimeUpdateRequired);
  };

  useEffect(() => {
    let cancelled = false;
    if (!api) {
      setLoading(false);
      setError(LOAD_ERROR);
      return;
    }
    api.get<unknown>(AGENT_PATH)
      .then((raw) => {
        if (cancelled) return;
        const config = normalizeAgentConfig(raw);
        setView(config.extended);
        setLegacy(config.runtimeUpdateRequired);
        setError(null);
      })
      .catch((loadError: unknown) => {
        if (!cancelled) {
          setView(null);
          setLegacy(false);
          setError(toUserMessage(loadError));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  const mutate = async (body: Record<string, unknown>) => {
    if (!api) return;
    setBusy(true);
    setError(null);
    try {
      const raw = await api.put<unknown>(AGENT_PATH, body);
      const config = normalizeAgentConfig(raw);
      if (config.extended) setView(config.extended);
      else await load();
    } catch (mutationError: unknown) {
      setView(null);
      setLegacy(false);
      setError(toUserMessage(mutationError) || UPDATE_ERROR);
    } finally {
      setBusy(false);
    }
  };

  const openSetup = async (setup: ProviderSetupCommand) => {
    if (!api) return;
    setError(null);
    if (!await openProviderSetupTerminal(api, setup, openTab, "agent-settings")) {
      setError(SETUP_ERROR);
    }
  };

  const saveKey = async (key: string) => {
    if (!api) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(API_KEY_PATH, { apiKey: key });
      await load();
    } catch (keyError: unknown) {
      setView(null);
      setLegacy(false);
      setError(toUserMessage(keyError));
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <Card><Empty text="Loading agent runtime settings…" /></Card>;
  if (legacy) {
    return (
      <Card>
        <span className="text-sm font-medium" style={{ color: "var(--warning)" }}>Runtime update needed</span>
        <p className="text-xs" style={{ color: "var(--text-secondary)" }}>
          This computer keeps Chat model and effort controls, but needs a newer gateway for runtime and provider controls.
        </p>
      </Card>
    );
  }
  if (!view) return <Card><Empty text={error ?? LOAD_ERROR} /></Card>;

  return (
    <Card>
      <div className="flex items-start gap-2">
        <Radio size={15} style={{ color: "var(--accent)" }} />
        <div>
          <span className="block text-sm font-medium" style={{ color: "var(--text-primary)" }}>Messaging runtime</span>
          <p className="text-xs" style={{ color: "var(--text-secondary)" }}>
            Controls optional messaging channels. Matrix Chat continues through the kernel above.
          </p>
        </div>
      </div>
      {error ? <span role="alert" className="text-xs" style={{ color: "var(--danger)" }}>{error}</span> : null}
      <RuntimeOptions
        view={view}
        busy={busy}
        onSwitch={(runtime) => void mutate({ runtime, revision: view.revision })}
      />
      <div className="flex flex-col gap-2">
        <span className="text-xs font-medium" style={{ color: "var(--text-secondary)" }}>Chat provider authentication</span>
        <ChatAuthentication view={view} busy={busy} onSaveKey={saveKey} onOpenSetup={openSetup} />
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-xs font-medium" style={{ color: "var(--text-secondary)" }}>Messaging provider</span>
        <MessagingProvider
          key={`${view.revision}:${view.runtime.selected}`}
          view={view}
          busy={busy}
          onOpenSetup={openSetup}
          onSave={(provider, messagingModel) => void mutate({
            provider,
            messagingModel,
            revision: view.revision,
          })}
        />
      </div>
    </Card>
  );
}
