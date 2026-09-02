"use client";

import { useEffect, useState } from "react";
import type {
  AgentEffort,
  AgentProviderDescriptor,
  AgentRuntimeId,
  AgentSettingsView,
  AiProviderSnapshotV3,
} from "@matrix-os/contracts";
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  CpuIcon,
  KeyRoundIcon,
  LoaderCircleIcon,
  RadioIcon,
  RefreshCwIcon,
  Settings2Icon,
  TerminalIcon,
} from "@/lib/hugeicons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  AgentSettingsClientError,
  loadAgentSettings,
  saveAnthropicApiKey,
  updateAgentSettings,
  type NormalizedAgentSettings,
} from "@/lib/agent-config";
import type { TerminalLaunchAction } from "@/lib/terminal-launch";
import {
  deriveReadyModelChoices,
  loadAiProviderSnapshot,
} from "@/lib/ai-providers";
import { HermesConfigurationDialog } from "./HermesConfigurationDialog";

interface AgentRuntimePanelProps {
  onOpenTerminal?: (action: TerminalLaunchAction) => void;
}

function safeMessage(error: unknown): string {
  return error instanceof AgentSettingsClientError
    ? error.message
    : "Agent settings could not be updated.";
}

function statusLabel(value: string): string {
  return value.split("_").map((part) => (
    part.length === 0 ? part : part[0].toUpperCase() + part.slice(1)
  )).join(" ");
}

function availableModels(provider: AgentProviderDescriptor | undefined) {
  const models: AgentProviderDescriptor["models"] = [];
  for (const model of provider?.models ?? []) {
    if (model.available) models.push(model);
  }
  return models;
}

function StatusBadge({ state }: { state: string }) {
  const ready = state === "healthy" || state === "ready" || state === "active";
  return (
    <Badge variant="secondary" className={ready ? "bg-forest/10 text-forest" : undefined}>
      {ready ? <CheckCircle2Icon className="size-3" /> : <AlertTriangleIcon className="size-3" />}
      {statusLabel(state)}
    </Badge>
  );
}

function accountStateLabel(state: AiProviderSnapshotV3["accounts"][number]["state"]): string {
  return state === "setup_required" ? "Not connected" : statusLabel(state);
}

function fundingLabel(kind: AiProviderSnapshotV3["accessSources"][number]["fundingKind"]): string {
  if (kind === "matrix_included") return "Included";
  if (kind === "matrix_addon") return "Matrix add-on";
  return "Owner-funded";
}

export function ProviderTruthCards({ snapshot }: { snapshot: AiProviderSnapshotV3 }) {
  const readyModels = deriveReadyModelChoices(snapshot);
  return (
    <div className="grid gap-4 xl:grid-cols-3">
      <Card role="region" aria-label="AI access">
        <CardHeader className="gap-1">
          <CardTitle className="text-sm">AI access</CardTitle>
          <p className="text-xs text-muted-foreground">Who supplies the credential and pays for each run.</p>
        </CardHeader>
        <CardContent className="space-y-2">
          {snapshot.accessSources.map((source) => (
            <div key={source.id} className="flex items-center justify-between gap-3 rounded-lg border border-border/60 p-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold">{source.displayName}</p>
                <p className="text-xs text-muted-foreground">{fundingLabel(source.fundingKind)}</p>
              </div>
              <StatusBadge state={source.state} />
            </div>
          ))}
        </CardContent>
      </Card>

      <Card role="region" aria-label="Provider accounts">
        <CardHeader className="gap-1">
          <CardTitle className="text-sm">Provider accounts</CardTitle>
          <p className="text-xs text-muted-foreground">Your own provider connections, separate from Matrix access.</p>
        </CardHeader>
        <CardContent className="space-y-2">
          {snapshot.accounts.map((account) => (
            <div key={account.id} className="flex items-center justify-between gap-3 rounded-lg border border-border/60 p-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold">
                  {account.vendor === "openrouter" ? "OpenRouter" : account.vendor === "anthropic" ? "Anthropic" : statusLabel(account.vendor)}
                </p>
                <p className="text-xs text-muted-foreground">{accountStateLabel(account.state)}</p>
              </div>
              <StatusBadge state={account.state} />
            </div>
          ))}
        </CardContent>
      </Card>

      <Card role="region" aria-label="AI harnesses">
        <CardHeader className="gap-1">
          <CardTitle className="text-sm">AI harnesses</CardTitle>
          <p className="text-xs text-muted-foreground">Installed execution engines and their current health.</p>
        </CardHeader>
        <CardContent className="space-y-2">
          {snapshot.drivers.map((driver) => (
            <div key={driver.id} className="rounded-lg border border-border/60 p-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold">{driver.displayName}</p>
                  <p className="text-xs text-muted-foreground">{statusLabel(driver.installState)}</p>
                </div>
                <StatusBadge state={driver.health} />
              </div>
            </div>
          ))}
          {readyModels.length > 0 && (
            <div className="rounded-lg bg-muted/30 p-3">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Ready models</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {readyModels.map((model) => (
                  <Badge key={`${model.instanceId}:${model.modelId}`} variant="outline">{model.modelLabel}</Badge>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function RuntimeCards({
  view,
  busy,
  onOpenTerminal,
  onSwitch,
}: {
  view: AgentSettingsView;
  busy: boolean;
  onOpenTerminal?: (action: TerminalLaunchAction) => void;
  onSwitch: (runtime: AgentRuntimeId) => void;
}) {
  return (
    <Card>
      <CardHeader className="gap-1">
        <CardTitle className="flex items-center gap-2 text-sm">
          <RadioIcon className="size-4 text-ember" />
          Messaging runtime
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Controls Telegram, WhatsApp, and other optional messaging channels. Chat stays on the Matrix kernel.
        </p>
      </CardHeader>
      <CardContent className="grid gap-3 md:grid-cols-2">
        {view.runtime.options.map((runtime) => {
          const selected = runtime.id === view.runtime.selected;
          const installed = runtime.installState === "installed";
          const active = selected && installed && runtime.selectionState === "active";
          const installAction: TerminalLaunchAction = runtime.id === "hermes"
            ? "hermes-install"
            : "openclaw-install";
          const restartAction: TerminalLaunchAction = runtime.id === "hermes"
            ? "hermes-restart"
            : "openclaw-restart";
          const canInstall = !installed && runtime.setupAction === "install" && onOpenTerminal;
          const canRestart = selected
            && installed
            && runtime.selectionState === "action_required"
            && onOpenTerminal;
          return (
            <article
              key={runtime.id}
              className={`rounded-xl border p-4 transition-colors ${selected ? "border-ember/50 bg-ember/5" : "border-border/60 bg-background/30"}`}
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h4 className="text-sm font-semibold">{runtime.displayName}</h4>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {runtime.version ? `Version ${runtime.version}` : statusLabel(runtime.installState)}
                  </p>
                </div>
                <div className="flex flex-wrap justify-end gap-1.5">
                  <StatusBadge state={runtime.health} />
                  {!installed && <Badge variant="outline">Not installed</Badge>}
                </div>
              </div>
              <div className="mt-4">
                {active ? (
                  <p className="text-xs font-medium text-forest">{runtime.displayName} is active</p>
                ) : canInstall ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => onOpenTerminal(installAction)}
                    aria-label={`Install ${runtime.displayName}`}
                  >
                    <TerminalIcon className="size-3.5" /> Install {runtime.displayName}
                  </Button>
                ) : canRestart ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => onOpenTerminal(restartAction)}
                    aria-label={`Restart ${runtime.displayName}`}
                  >
                    <TerminalIcon className="size-3.5" /> Restart {runtime.displayName}
                  </Button>
                ) : selected ? (
                  <p className="text-xs font-medium text-warning">
                    {runtime.displayName} is selected · {statusLabel(runtime.selectionState)}
                  </p>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || !installed || runtime.selectionState === "unavailable"}
                    onClick={() => onSwitch(runtime.id)}
                    aria-label={`Use ${runtime.displayName}`}
                  >
                    {installed ? `Use ${runtime.displayName}` : "Runtime update needed"}
                  </Button>
                )}
              </div>
            </article>
          );
        })}
      </CardContent>
    </Card>
  );
}

function ChatCard({
  view,
  busy,
  onSave,
  onOpenTerminal,
  onSaveKey,
}: {
  view: AgentSettingsView;
  busy: boolean;
  onSave: (model: string, effort?: AgentEffort) => void;
  onOpenTerminal?: (action: TerminalLaunchAction) => void;
  onSaveKey: (key: string) => Promise<void>;
}) {
  const provider = view.providers.find((entry) => entry.runtime === null && entry.scopes.includes("chat"));
  const chatModels = availableModels(provider);
  const [modelOverride, setModelOverride] = useState("");
  const [effortOverride, setEffortOverride] = useState<AgentEffort | "">("");
  const preferredModel = modelOverride
    || view.chat?.model
    || view.kernel.model
    || view.defaults.model
    || "";
  const selectedModel = chatModels.some((entry) => entry.id === preferredModel)
    ? preferredModel
    : chatModels[0]?.id ?? "";
  const effortOptions = provider?.models.find((entry) => entry.id === selectedModel)?.efforts
    ?? view.availableEfforts;
  const preferredEffort = effortOverride
    || view.chat?.effort
    || view.kernel.effort
    || view.defaults.effort
    || "";
  const selectedEffort = preferredEffort !== "" && effortOptions.includes(preferredEffort)
    ? preferredEffort
    : effortOptions[0] ?? "";
  const [showKey, setShowKey] = useState(false);
  const [apiKey, setApiKey] = useState("");

  const submitKey = async () => {
    const key = apiKey;
    setApiKey("");
    await onSaveKey(key);
  };

  return (
    <Card>
      <CardHeader className="gap-1">
        <CardTitle className="flex items-center gap-2 text-sm">
          <CpuIcon className="size-4 text-ember" />
          Chat agent
        </CardTitle>
        <p className="text-xs text-muted-foreground">Your saved model applies to every shell. A message can still override it once.</p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="agent-chat-model">Model</Label>
            <select
              id="agent-chat-model"
              aria-label="Chat model"
              className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
              value={selectedModel}
              onChange={(event) => setModelOverride(event.target.value)}
            >
              {chatModels.map((entry) => (
                <option key={entry.id} value={entry.id}>{entry.displayName}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="agent-chat-effort">Effort</Label>
            <select
              id="agent-chat-effort"
              aria-label="Chat effort"
              className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
              value={selectedEffort}
              onChange={(event) => setEffortOverride(event.target.value as AgentEffort)}
            >
              {effortOptions.length === 0 && <option value="">Not available</option>}
              {effortOptions.map((entry) => <option key={entry} value={entry}>{statusLabel(entry)}</option>)}
            </select>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <StatusBadge state={provider?.authStatus.state ?? "unknown"} />
            <span>{provider?.displayName ?? "Provider unavailable"}</span>
          </div>
          <Button
            size="sm"
            disabled={busy || !selectedModel}
            onClick={() => onSave(selectedModel, selectedEffort || undefined)}
          >
            Save Chat model
          </Button>
        </div>
        {provider && (
          <div className="rounded-lg border border-border/60 bg-muted/20 p-3">
            <p className="text-xs font-medium">Authentication</p>
            <p className="mt-1 text-xs text-muted-foreground">Use Matrix access, your own key, or a Claude subscription login. Keys are submitted once and never stored in this browser.</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {provider.supportedAuthKinds.includes("api_key") && (
                <Button size="sm" variant="outline" onClick={() => setShowKey((value) => !value)}>
                  <KeyRoundIcon className="size-3.5" /> Use my API key
                </Button>
              )}
              {provider.supportedAuthKinds.includes("oauth_login") && onOpenTerminal && (
                <Button size="sm" variant="outline" onClick={() => onOpenTerminal("claude-login")}>
                  <TerminalIcon className="size-3.5" /> Sign in with Claude
                </Button>
              )}
            </div>
            {showKey && (
              <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                <div className="min-w-0 flex-1 space-y-1.5">
                  <Label htmlFor="anthropic-api-key">Anthropic API key</Label>
                  <Input
                    id="anthropic-api-key"
                    type="password"
                    autoComplete="off"
                    value={apiKey}
                    onChange={(event) => setApiKey(event.target.value)}
                  />
                </div>
                <Button className="self-end" size="sm" disabled={busy || apiKey.length < 8} onClick={() => void submitKey()}>
                  Save API key
                </Button>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function MessagingProviders({
  view,
  busy,
  onSave,
  onOpenTerminal,
}: {
  view: AgentSettingsView;
  busy: boolean;
  onSave: (provider: string, model: string) => void;
  onOpenTerminal?: (action: TerminalLaunchAction) => void;
}) {
  const providers = view.providers.filter((provider) => provider.runtime === view.runtime.selected);
  const current = view.currentSelection.messaging;
  const [providerOverride, setProviderOverride] = useState("");
  const preferredProviderId = providerOverride || current.provider || "";
  const selectedProviderId = providers.some((entry) => entry.id === preferredProviderId)
    ? preferredProviderId
    : current.provider && providers.some((entry) => entry.id === current.provider)
      ? current.provider
      : providers[0]?.id ?? "";
  const provider = providers.find((entry) => entry.id === selectedProviderId);
  const providerModels = availableModels(provider);
  const [modelOverride, setModelOverride] = useState("");
  const preferredModel = modelOverride || current.model || "";
  const selectedModel = providerModels.some((entry) => entry.id === preferredModel)
    ? preferredModel
    : providerModels[0]?.id ?? "";
  const isHermes = view.runtime.selected === "hermes";
  const [hermesConfigOpen, setHermesConfigOpen] = useState(false);
  const hermesVersion = view.runtime.options.find((runtime) => runtime.id === "hermes")?.version;
  const terminalAction = "openclaw-model-auth";
  const configureAction = isHermes ? (
    <Button
      size="sm"
      variant="outline"
      disabled={busy}
      onClick={() => setHermesConfigOpen(true)}
      aria-label="Configure Hermes provider"
    >
      <Settings2Icon className="size-3.5" /> Configure Hermes
    </Button>
  ) : onOpenTerminal ? (
    <Button
      size="sm"
      variant="outline"
      disabled={busy}
      onClick={() => onOpenTerminal(terminalAction)}
      aria-label="Configure Openclaw provider"
    >
      <TerminalIcon className="size-3.5" /> Configure OpenClaw
    </Button>
  ) : null;
  const hermesDialog = (
    <HermesConfigurationDialog
      open={hermesConfigOpen}
      onOpenChange={setHermesConfigOpen}
      version={hermesVersion}
    />
  );

  if (providers.length === 0) {
    return (
      <>
        <Card>
          <CardContent className="flex min-h-32 flex-col items-center justify-center gap-2 py-8 text-center">
            <AlertTriangleIcon className="size-5 text-muted-foreground" />
            <p className="text-sm font-medium">No providers available</p>
            <p className="max-w-sm text-xs text-muted-foreground">Start and configure the selected messaging runtime, then retry.</p>
            {configureAction}
          </CardContent>
        </Card>
        {hermesDialog}
      </>
    );
  }

  return (
    <Card>
      <CardHeader className="gap-1">
        <CardTitle className="text-sm">Messaging provider</CardTitle>
        <p className="text-xs text-muted-foreground">Choose the provider and model used by {statusLabel(view.runtime.selected)}.</p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div role="group" aria-label="Messaging providers" className="grid gap-2 sm:grid-cols-2">
          {providers.map((entry) => {
            const selected = entry.id === selectedProviderId;
            return (
              <button
                key={entry.id}
                type="button"
                aria-label={`Choose ${entry.displayName}`}
                aria-pressed={selected}
                className={`rounded-xl border p-3 text-left transition-colors ${selected ? "border-ember/50 bg-ember/5" : "border-border/60 bg-background/30 hover:border-border"}`}
                onClick={() => {
                  setProviderOverride(entry.id);
                  setModelOverride(availableModels(entry)[0]?.id ?? "");
                }}
              >
                <span className="flex items-start justify-between gap-2">
                  <span>
                    <span className="block text-sm font-semibold">{entry.displayName}</span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">{statusLabel(entry.authKind)}</span>
                  </span>
                  <StatusBadge state={entry.authStatus.state} />
                </span>
              </button>
            );
          })}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="agent-messaging-model">Model</Label>
          <select
            id="agent-messaging-model"
            aria-label="Messaging model"
            className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
            value={selectedModel}
            onChange={(event) => setModelOverride(event.target.value)}
          >
            {availableModels(provider).map((entry) => (
              <option key={entry.id} value={entry.id}>{entry.displayName}</option>
            ))}
          </select>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <StatusBadge state={provider?.authStatus.state ?? "unknown"} />
            <span className="text-xs text-muted-foreground">{provider?.displayName}</span>
          </div>
          <div className="flex gap-2">
            {configureAction}
            <Button size="sm" disabled={busy || !selectedProviderId || !selectedModel} onClick={() => onSave(selectedProviderId, selectedModel)}>
              Save messaging model
            </Button>
          </div>
        </div>
      </CardContent>
      {hermesDialog}
    </Card>
  );
}

function LegacyFallback({
  settings,
  busy,
  onSave,
}: {
  settings: Extract<NormalizedAgentSettings, { kind: "legacy" }>;
  busy: boolean;
  onSave: (model: string, effort: AgentEffort | null) => void;
}) {
  const models = settings.view.availableModels ?? [];
  const efforts = settings.view.availableEfforts ?? [];
  const initialEffort = settings.effort && efforts.includes(settings.effort)
    ? settings.effort
    : "";
  const initialModel = settings.model && models.some((entry) => entry.id === settings.model)
    ? settings.model
    : models[0]?.id ?? "";
  const [model, setModel] = useState(initialModel);
  const [effort, setEffort] = useState<AgentEffort | "">(initialEffort);
  return (
    <section aria-label="Legacy agent settings" className="space-y-3">
      <div className="rounded-xl border border-warning/30 bg-warning/5 p-4">
        <div className="flex items-center gap-2 text-sm font-semibold"><AlertTriangleIcon className="size-4 text-warning" />Runtime update needed</div>
        <p className="mt-1 text-xs text-muted-foreground">This computer supports Chat model and effort, but needs a newer gateway for runtime and provider controls.</p>
      </div>
      <Card>
        <CardHeader><CardTitle className="text-sm">Chat agent</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="legacy-agent-chat-model">Model</Label>
              <select
                id="legacy-agent-chat-model"
                aria-label="Legacy Chat model"
                className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
                value={model}
                onChange={(event) => setModel(event.target.value)}
              >
                {!model && <option value="">Default model</option>}
                {models.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="legacy-agent-chat-effort">Effort</Label>
              <select
                id="legacy-agent-chat-effort"
                aria-label="Legacy Chat effort"
                className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
                value={effort}
                onChange={(event) => setEffort(event.target.value as AgentEffort | "")}
              >
                <option value="">Default effort</option>
                {efforts.map((entry) => <option key={entry} value={entry}>{statusLabel(entry)}</option>)}
              </select>
            </div>
          </div>
          <Button size="sm" disabled={busy || !model} onClick={() => onSave(model, effort || null)}>
            Save Chat model
          </Button>
        </CardContent>
      </Card>
    </section>
  );
}

export function AgentRuntimePanel({ onOpenTerminal }: AgentRuntimePanelProps) {
  const [settings, setSettings] = useState<NormalizedAgentSettings | null>(null);
  const [providerSnapshot, setProviderSnapshot] = useState<AiProviderSnapshotV3 | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editResetVersion, setEditResetVersion] = useState(0);

  const reload = async () => {
    setLoading(true);
    setError(null);
    await Promise.allSettled([
      loadAgentSettings(),
      loadAiProviderSnapshot({ refresh: true }),
    ]).then(([loaded, providers]) => {
      if (loaded.status === "fulfilled") setSettings(loaded.value);
      else setError(safeMessage(loaded.reason));
      if (providers.status === "fulfilled") setProviderSnapshot(providers.value);
    }).finally(() => setLoading(false));
  };

  useEffect(() => {
    let cancelled = false;
    void Promise.allSettled([
      loadAgentSettings(),
      loadAiProviderSnapshot(),
    ]).then(([loaded, providers]) => {
      if (!cancelled) {
        if (loaded.status === "fulfilled") setSettings(loaded.value);
        else setError(safeMessage(loaded.reason));
        if (providers.status === "fulfilled") setProviderSnapshot(providers.value);
      }
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const mutate = async (operation: () => Promise<NormalizedAgentSettings>) => {
    setBusy(true);
    setError(null);
    try {
      const updated = await operation();
      setSettings(updated);
      try {
        setProviderSnapshot(await loadAiProviderSnapshot({ refresh: true }));
      } catch (refreshError) {
        console.warn(
          "[settings] Provider projection refresh failed:",
          refreshError instanceof Error ? refreshError.name : "UnknownError",
        );
      }
    } catch (mutationError) {
      setError(safeMessage(mutationError));
      setEditResetVersion((version) => version + 1);
    }
    setBusy(false);
  };

  const saveKey = async (key: string) => {
    setBusy(true);
    setError(null);
    try {
      await saveAnthropicApiKey(key);
      setSettings(await loadAgentSettings());
      try {
        setProviderSnapshot(await loadAiProviderSnapshot({ refresh: true }));
      } catch (refreshError) {
        console.warn(
          "[settings] Provider projection refresh failed:",
          refreshError instanceof Error ? refreshError.name : "UnknownError",
        );
      }
    } catch (keyError) {
      setError(safeMessage(keyError));
    }
    setBusy(false);
  };

  if (loading && settings === null) {
    return (
      <div role="status" className="flex min-h-48 items-center justify-center gap-2 text-sm text-muted-foreground">
        <LoaderCircleIcon className="size-4 animate-spin" /> Loading agent settings
      </div>
    );
  }

  if (error && settings === null) {
    return (
      <div role="alert" className="flex min-h-48 flex-col items-center justify-center gap-3 rounded-xl border border-destructive/20 bg-destructive/5 p-6 text-center">
        <AlertTriangleIcon className="size-5 text-destructive" />
        <p className="text-sm font-medium">{error}</p>
        <Button size="sm" variant="outline" onClick={() => void reload()}><RefreshCwIcon className="size-3.5" />Retry</Button>
      </div>
    );
  }

  if (settings?.kind === "legacy") {
    const legacyEditKey = JSON.stringify({
      model: settings.model,
      effort: settings.effort,
      models: settings.view.availableModels?.map((entry) => entry.id),
      efforts: settings.view.availableEfforts,
      editResetVersion,
    });
    return (
      <div className="space-y-4">
        {error && <div role="alert" className="rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs text-destructive">{error}</div>}
        <LegacyFallback
          key={legacyEditKey}
          settings={settings}
          busy={busy}
          onSave={(model, effort) => void mutate(() => updateAgentSettings({ model, effort }))}
        />
      </div>
    );
  }
  if (settings?.kind !== "current") return null;
  const view = settings.view;

  return (
    <div className="space-y-4">
      {error && <div role="alert" className="rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs text-destructive">{error}</div>}
      {providerSnapshot && <ProviderTruthCards snapshot={providerSnapshot} />}
      <ChatCard
        key={`${view.chat?.model ?? "inactive"}:${view.chat?.effort ?? "none"}:${view.chat?.authKind ?? "none"}:${editResetVersion}`}
        view={view}
        busy={busy}
        onOpenTerminal={onOpenTerminal}
        onSave={(model, effort) => void mutate(() => updateAgentSettings({
          model,
          effort: effort ?? null,
        }))}
        onSaveKey={saveKey}
      />
      <RuntimeCards
        view={view}
        busy={busy}
        onOpenTerminal={onOpenTerminal}
        onSwitch={(runtime) => void mutate(() => updateAgentSettings({ runtime, revision: view.revision }))}
      />
      <MessagingProviders
        key={`${view.runtime.selected}:${view.currentSelection.messaging.provider ?? "none"}:${editResetVersion}`}
        view={view}
        busy={busy}
        onOpenTerminal={onOpenTerminal}
        onSave={(provider, messagingModel) => void mutate(() => updateAgentSettings({
          provider,
          messagingModel,
          revision: view.revision,
        }))}
      />
    </div>
  );
}
