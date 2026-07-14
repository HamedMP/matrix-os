import type { AgentProviderSummary, RuntimeSummary } from "@matrix-os/contracts";
import { Save, SquareTerminal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { type AgentConfigView, normalizeAgentConfig, selectedModelEffort } from "../../../lib/agent-config";
import { Button, StatusDot } from "../../../design/primitives";
import { toUserMessage } from "../../../lib/errors";
import { invoke } from "../../../lib/operator";
import { useConnection } from "../../../stores/connection";
import { useTabs } from "../../../stores/tabs";
import { openProviderSetupTerminal, providerSetupCommands, type ProviderSetupCommand } from "../../coding-agents/provider-setup-terminal";
import { Card, Empty, SectionHeader } from "./section-kit";
import AgentRuntimeSettingsCard from "./AgentRuntimeSettingsCard";

const SOUL_PATH = "/files/system/soul.md";
const AGENT_PATH = "/api/settings/agent";
const CREDENTIALS_PATH = "/api/agents/credentials/status";

interface AgentCredential {
  agent: string;
  status: "available" | "missing" | "expired" | "revoked" | "failed";
  coordinationRole?: string;
  nextAction?: string | null;
}
interface CredentialStatus {
  systemAgent?: string;
  routingExplanation?: string;
  agents?: AgentCredential[];
}

const STATUS_COLOR: Record<AgentCredential["status"], string> = {
  available: "var(--success)",
  missing: "var(--text-tertiary)",
  expired: "var(--warning)",
  revoked: "var(--warning)",
  failed: "var(--danger)",
};

const PROVIDER_STATUS_COLOR: Record<AgentProviderSummary["availability"], string> = {
  available: "var(--success)",
  setup_required: "var(--warning)",
  auth_required: "var(--warning)",
  installing: "var(--accent)",
  unavailable: "var(--danger)",
  unknown: "var(--text-tertiary)",
};

const SETUP_DISCONNECTED_ERROR = "Connect to your Matrix computer before opening setup.";
const SETUP_TERMINAL_ERROR = "Could not open setup terminal. Try again from Terminal.";

function titleCaseStatus(value: string): string {
  const label = value.replace(/_/g, " ");
  return `${label.charAt(0).toUpperCase()}${label.slice(1)}`;
}

function providerStatusLine(provider: AgentProviderSummary): string {
  return `${titleCaseStatus(provider.availability)} · ${provider.installStatus} / ${provider.authStatus}`;
}

function Segmented<T extends string>({
  options,
  value,
  onChange,
  labelFor,
}: {
  options: readonly T[];
  value: T | null;
  onChange: (v: T) => void;
  labelFor?: (v: T) => string;
}) {
  return (
    <div className="flex rounded-lg border p-0.5" style={{ borderColor: "var(--border-subtle)", background: "var(--bg-sunken)" }}>
      {options.map((opt) => {
        const active = opt === value;
        return (
          <button
            key={opt}
            type="button"
            onClick={() => onChange(opt)}
            className="flex-1 whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition-colors duration-100"
            style={{
              background: active ? "var(--bg-surface)" : "transparent",
              color: active ? "var(--text-primary)" : "var(--text-secondary)",
              boxShadow: active ? "var(--shadow-1)" : "none",
            }}
          >
            {labelFor ? labelFor(opt) : opt}
          </button>
        );
      })}
    </div>
  );
}

function SoulEditor() {
  const api = useConnection((s) => s.api);
  const [soul, setSoul] = useState("");
  const [baseline, setBaseline] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const saveSeqRef = useRef(0);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    api
      .getText(SOUL_PATH)
      .then((text) => {
        if (cancelled) return;
        setSoul(text);
        setBaseline(text);
        setLoaded(true);
        setError(null);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setLoaded(true);
          setError(toUserMessage(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  const dirty = soul !== baseline;
  const save = async () => {
    if (!api || !dirty) return;
    const saveSeq = saveSeqRef.current + 1;
    saveSeqRef.current = saveSeq;
    const nextSoul = soul;
    if (savedTimerRef.current) {
      clearTimeout(savedTimerRef.current);
      savedTimerRef.current = null;
    }
    setStatus("saving");
    setError(null);
    try {
      await api.putText(SOUL_PATH, nextSoul);
      if (!mountedRef.current || saveSeqRef.current !== saveSeq) return;
      setBaseline(nextSoul);
      setError(null);
      setStatus("saved");
      savedTimerRef.current = setTimeout(() => {
        savedTimerRef.current = null;
        if (mountedRef.current && saveSeqRef.current === saveSeq) setStatus("idle");
      }, 1500);
    } catch (err: unknown) {
      if (!mountedRef.current || saveSeqRef.current !== saveSeq) return;
      setError(toUserMessage(err));
      setStatus("error");
    }
  };

  return (
    <Card>
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>SOUL · system/soul.md</span>
        <div className="flex items-center gap-2">
          {status === "saved" ? <span className="text-xs" style={{ color: "var(--success)" }}>Saved</span> : null}
          <Button variant="primary" disabled={!dirty || status === "saving"} onClick={() => void save()}>
            <Save size={13} />
            {status === "saving" ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
      {!loaded ? (
        <Empty text="Loading…" />
      ) : (
        <textarea
          value={soul}
          onChange={(e) => setSoul(e.target.value)}
          spellCheck={false}
          aria-label="SOUL system instructions"
          className="min-h-[260px] w-full resize-y rounded-lg border bg-transparent p-3 font-mono text-xs leading-relaxed outline-none"
          style={{ borderColor: "var(--border-default)", color: "var(--text-primary)", background: "var(--bg-sunken)" }}
          placeholder="# SOUL&#10;&#10;You are Hermes, the Matrix OS agent…"
          data-selectable
        />
      )}
      {error ? <span className="text-xs" style={{ color: "var(--danger)" }}>{error}</span> : null}
    </Card>
  );
}

function ModelEffortCard() {
  const api = useConnection((s) => s.api);
  const [config, setConfig] = useState<AgentConfigView | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [effort, setEffort] = useState<string | null>(null);
  const [base, setBase] = useState<{ model: string | null; effort: string | null }>({ model: null, effort: null });
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const saveSeqRef = useRef(0);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
      saveSeqRef.current += 1;
      if (savedTimerRef.current) {
        clearTimeout(savedTimerRef.current);
        savedTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    api
      .get<unknown>(AGENT_PATH)
      .then((raw) => {
        if (cancelled) return;
        const cfg = normalizeAgentConfig(raw);
        const { model: m, effort: e } = selectedModelEffort(cfg);
        setConfig(cfg);
        setModel(m);
        setEffort(e);
        setBase({ model: m, effort: e });
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(toUserMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  const dirty = model !== base.model || effort !== base.effort;
  const save = async () => {
    if (!api || !dirty || !model || !effort) return;
    const saveSeq = saveSeqRef.current + 1;
    saveSeqRef.current = saveSeq;
    if (savedTimerRef.current) {
      clearTimeout(savedTimerRef.current);
      savedTimerRef.current = null;
    }
    setStatus("saving");
    setError(null);
    try {
      await api.put(AGENT_PATH, { model, effort });
      if (!mountedRef.current || saveSeqRef.current !== saveSeq) return;
      setBase({ model, effort });
      setError(null);
      setStatus("saved");
      savedTimerRef.current = setTimeout(() => {
        savedTimerRef.current = null;
        if (mountedRef.current && saveSeqRef.current === saveSeq) setStatus("idle");
      }, 1500);
    } catch (err: unknown) {
      if (!mountedRef.current || saveSeqRef.current !== saveSeq) return;
      setError(toUserMessage(err));
      setStatus("error");
    }
  };

  return (
    <Card>
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>Model &amp; reasoning</span>
        <div className="flex items-center gap-2">
          {status === "saved" ? <span className="text-xs" style={{ color: "var(--success)" }}>Saved</span> : null}
          <Button variant="primary" disabled={!dirty || status === "saving"} onClick={() => void save()}>
            <Save size={13} />
            {status === "saving" ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
      {!config ? (
        <Empty text={error ?? "Loading…"} />
      ) : config.availableModels.length === 0 ? (
        <Empty
          text={
            error ??
            "Your computer needs a runtime update before Hermes' model and reasoning effort can be configured here."
          }
        />
      ) : (
        <>
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium" style={{ color: "var(--text-secondary)" }}>Model</span>
            <Segmented
              options={config.availableModels.map((m) => m.id)}
              value={model}
              onChange={setModel}
              labelFor={(id) => config.availableModels.find((m) => m.id === id)?.label ?? id}
            />
            <span className="text-xs" style={{ color: "var(--text-tertiary)" }}>
              {config.availableModels.find((m) => m.id === model)?.tier ?? "Used by Hermes for every conversation."}
            </span>
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium" style={{ color: "var(--text-secondary)" }}>Reasoning effort</span>
            <Segmented options={config.availableEfforts} value={effort} onChange={setEffort} />
            <span className="text-xs" style={{ color: "var(--text-tertiary)" }}>
              Higher effort means deeper thinking and slower, more thorough responses.
            </span>
          </div>
          {error ? <span className="text-xs" style={{ color: "var(--danger)" }}>{error}</span> : null}
        </>
      )}
    </Card>
  );
}

function ProvidersCard() {
  const api = useConnection((s) => s.api);
  const [status, setStatus] = useState<CredentialStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    api
      .get<CredentialStatus>(CREDENTIALS_PATH)
      .then((s) => {
        if (!cancelled) setStatus(s);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(toUserMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  return (
    <Card>
      <span className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>Coding agents &amp; credentials</span>
      {status?.routingExplanation ? (
        <p className="text-xs" style={{ color: "var(--text-secondary)" }}>{status.routingExplanation}</p>
      ) : null}
      {!status ? (
        <Empty text={error ?? "Checking provider status…"} />
      ) : (
        <div className="flex flex-col gap-2">
          {(status.agents ?? []).map((a) => (
            <div
              key={a.agent}
              className="flex items-center justify-between rounded-lg border px-3 py-2"
              style={{ borderColor: "var(--border-subtle)", background: "var(--bg-sunken)" }}
            >
              <div className="flex items-center gap-2.5">
                <StatusDot color={STATUS_COLOR[a.status]} />
                <div className="flex flex-col">
                  <span className="text-sm font-medium capitalize" style={{ color: "var(--text-primary)" }}>{a.agent}</span>
                  {a.coordinationRole ? (
                    <span className="text-xs" style={{ color: "var(--text-tertiary)" }}>{a.coordinationRole.replace(/_/g, " ")}</span>
                  ) : null}
                </div>
              </div>
              <span className="text-right text-xs" style={{ color: a.status === "available" ? "var(--success)" : "var(--text-secondary)" }}>
                {a.status === "available" ? "Ready" : (a.nextAction ?? a.status)}
              </span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function RuntimeProvidersCard() {
  const api = useConnection((s) => s.api);
  const runtimeSlot = useConnection((s) => s.runtimeSlot);
  const openTab = useTabs((s) => s.openTab);
  const [summary, setSummary] = useState<RuntimeSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [setupError, setSetupError] = useState<string | null>(null);

  useEffect(() => {
    if (!api) {
      setSummary(null);
      setError("Provider status unavailable.");
      return;
    }
    let cancelled = false;
    setSummary(null);
    setError(null);
    setSetupError(null);
    invoke("runtime:get-summary", {})
      .then((nextSummary) => {
        if (cancelled) return;
        setSummary(nextSummary);
        setError(null);
      })
      .catch((err: unknown) => {
        console.error("[settings] Failed to load runtime provider summary:", err instanceof Error ? err.name : typeof err);
        if (!cancelled) setError("Provider status unavailable.");
      });
    return () => {
      cancelled = true;
    };
  }, [api, runtimeSlot]);

  const openSetup = async (setup: ProviderSetupCommand) => {
    setSetupError(null);
    if (!api) {
      setSetupError(SETUP_DISCONNECTED_ERROR);
      return;
    }
    const opened = await openProviderSetupTerminal(api, setup, openTab, "settings");
    if (!opened) setSetupError(SETUP_TERMINAL_ERROR);
  };

  return (
    <Card>
      <span className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>Coding agent providers</span>
      {setupError ? <span className="text-xs" style={{ color: "var(--danger)" }}>{setupError}</span> : null}
      {!summary ? (
        <Empty text={error ?? "Checking provider status…"} />
      ) : summary.providers.length === 0 ? (
        <Empty text="No coding agent providers are configured yet." />
      ) : (
        <div className="flex flex-col gap-2">
          {summary.providers.map((provider) => {
            const setupCommands = providerSetupCommands([provider]);
            return (
              <div
                key={provider.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border px-3 py-2"
                style={{ borderColor: "var(--border-subtle)", background: "var(--bg-sunken)" }}
              >
                <div className="flex min-w-0 items-center gap-2.5">
                  <StatusDot color={PROVIDER_STATUS_COLOR[provider.availability]} />
                  <div className="flex min-w-0 flex-col">
                    <span className="truncate text-sm font-medium" style={{ color: "var(--text-primary)" }}>{provider.displayName}</span>
                    <span className="text-xs" style={{ color: "var(--text-tertiary)" }}>{providerStatusLine(provider)}</span>
                  </div>
                </div>
                {setupCommands.length > 0 ? (
                  <div className="flex flex-wrap items-center gap-2">
                    {setupCommands.map((setup) => (
                      <Button
                        key={setup.key}
                        variant="subtle"
                        aria-label={`Open provider setup ${setup.label}`}
                        onClick={() => void openSetup(setup)}
                      >
                        <SquareTerminal size={13} />
                        {setup.label}
                      </Button>
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

export default function AgentSection() {
  return (
    <>
      <SectionHeader
        title="Agent"
        description="Tune Matrix Chat, choose the runtime for messaging channels, authenticate providers, edit SOUL, and check which coding agents are connected."
      />
      <ModelEffortCard />
      <AgentRuntimeSettingsCard />
      <RuntimeProvidersCard />
      <ProvidersCard />
      <SoulEditor />
    </>
  );
}
