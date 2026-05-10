"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, Bot, CalendarDays, Check, ExternalLink, Mail, Mic, RefreshCw, Sparkles, Terminal } from "lucide-react";
import { getGatewayUrl } from "@/lib/gateway";

const GATEWAY = getGatewayUrl();

const CONNECT_SERVICES = [
  { id: "gmail", label: "Gmail", icon: Mail },
  { id: "google_calendar", label: "Calendar", icon: CalendarDays },
] as const;

const CODING_AGENTS = [
  { id: "claude_code", label: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "hermes", label: "Hermes" },
  { id: "openclaw", label: "OpenClaw" },
] as const;

type CodingAgentId = (typeof CODING_AGENTS)[number]["id"];

interface ConnectedService {
  id: string;
  service: string;
  account_label: string;
  account_email: string | null;
  status: string;
}

interface DetectedService {
  id: string;
  name: string;
  source: "email" | "calendar" | "user_included" | "user_missing";
  confidence: number;
  matrixReplacement?: string;
}

interface Recommendation {
  id: string;
  category: "connection" | "workflow" | "app" | "skill" | "routine";
  title: string;
  description: string;
  serviceId?: string;
  priority: "high" | "medium" | "low";
  matrixReplacement?: string;
}

interface RecommendationPlan {
  analyzedEmailCount: number;
  analyzedCalendarEventCount: number;
  detectedServices: DetectedService[];
  recommendations: Recommendation[];
  warnings: string[];
}

interface PersonalizedSetupStepProps {
  disabled: boolean;
  onStartVoice: () => void;
  onStartText: () => void;
}

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 25);
}

function serviceConnected(connections: ConnectedService[], serviceId: string): boolean {
  return connections.some((connection) => connection.service === serviceId && connection.status === "active");
}

function categoryLabel(category: Recommendation["category"]): string {
  switch (category) {
    case "connection":
      return "Connect";
    case "workflow":
      return "Workflow";
    case "app":
      return "App";
    case "skill":
      return "Skill";
    case "routine":
      return "Routine";
  }
}

function shouldLogSetupWarning(err: unknown): boolean {
  return !(err instanceof DOMException && err.name === "AbortError");
}

export function PersonalizedSetupStep({ disabled, onStartVoice, onStartText }: PersonalizedSetupStepProps) {
  const [connections, setConnections] = useState<ConnectedService[]>([]);
  const [loadingConnections, setLoadingConnections] = useState(true);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [plan, setPlan] = useState<RecommendationPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [includeDraft, setIncludeDraft] = useState("");
  const [missingDraft, setMissingDraft] = useState("");
  const [excludedServices, setExcludedServices] = useState<string[]>([]);
  const [codingAgents, setCodingAgents] = useState<CodingAgentId[]>([]);
  const connectionsRef = useRef<ConnectedService[]>([]);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollInFlightRef = useRef(false);
  const pollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const connectedIds = useMemo(
    () => CONNECT_SERVICES.filter((service) => serviceConnected(connections, service.id)).map((service) => service.id),
    [connections],
  );

  useEffect(() => {
    connectionsRef.current = connections;
  }, [connections]);

  const loadConnections = useCallback(async (sync = false) => {
    try {
      if (sync) {
        const syncRes = await fetch(`${GATEWAY}/api/integrations/sync`, {
          method: "POST",
          signal: AbortSignal.timeout(30_000),
        });
        if (syncRes.ok) {
          const data = await syncRes.json();
          if (Array.isArray(data.services)) {
            setConnections(data.services);
            return data.services as ConnectedService[];
          }
        }
      }

      const res = await fetch(`${GATEWAY}/api/integrations`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return connectionsRef.current;
      const data = await res.json();
      const next = Array.isArray(data.connections) ? data.connections : data;
      if (Array.isArray(next)) {
        setConnections(next);
        return next as ConnectedService[];
      }
      return connectionsRef.current;
    } catch (err) {
      if (shouldLogSetupWarning(err)) {
        console.warn("[onboarding] failed to load integration connections:", err instanceof Error ? err.message : err);
      }
      return connectionsRef.current;
    } finally {
      setLoadingConnections(false);
    }
  }, []);

  useEffect(() => {
    void loadConnections();
  }, [loadConnections]);

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      if (pollTimeoutRef.current) clearTimeout(pollTimeoutRef.current);
      pollInFlightRef.current = false;
    };
  }, []);

  const handleConnect = useCallback(async (serviceId: string) => {
    setConnecting(serviceId);
    setError(null);
    try {
      const res = await fetch(`${GATEWAY}/api/integrations/connect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ service: serviceId }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        setError("Connection could not start.");
        setConnecting(null);
        return;
      }
      const data = await res.json();
      if (typeof data.url === "string") {
        window.open(data.url, "_blank", "width=600,height=700");
      }

      if (pollRef.current) clearInterval(pollRef.current);
      if (pollTimeoutRef.current) clearTimeout(pollTimeoutRef.current);
      pollInFlightRef.current = false;
      pollRef.current = setInterval(() => {
        if (pollInFlightRef.current) return;
        pollInFlightRef.current = true;
        void loadConnections(true)
          .then((next) => {
            if (serviceConnected(next, serviceId)) {
              setConnecting(null);
              if (pollRef.current) clearInterval(pollRef.current);
              if (pollTimeoutRef.current) clearTimeout(pollTimeoutRef.current);
              pollRef.current = null;
              pollTimeoutRef.current = null;
            }
          })
          .finally(() => {
            pollInFlightRef.current = false;
          });
      }, 2000);
      pollTimeoutRef.current = setTimeout(() => {
        if (pollRef.current) clearInterval(pollRef.current);
        pollRef.current = null;
        pollInFlightRef.current = false;
        pollTimeoutRef.current = null;
        setConnecting(null);
      }, 120_000);
    } catch (err) {
      if (shouldLogSetupWarning(err)) {
        console.warn("[onboarding] integration connect failed:", err instanceof Error ? err.message : err);
      }
      setError("Connection could not start.");
      setConnecting(null);
    }
  }, [loadConnections]);

  const toggleCodingAgent = useCallback((id: CodingAgentId) => {
    setCodingAgents((prev) =>
      prev.includes(id) ? prev.filter((agent) => agent !== id) : [...prev, id],
    );
  }, []);

  const toggleDetectedService = useCallback((serviceId: string) => {
    setExcludedServices((prev) =>
      prev.includes(serviceId) ? prev.filter((id) => id !== serviceId) : [...prev, serviceId],
    );
  }, []);

  const handleAnalyze = useCallback(async (options?: { preserveExcludedServices?: boolean }) => {
    const nextExcludedServices = options?.preserveExcludedServices ? excludedServices : [];
    if (!options?.preserveExcludedServices) {
      setExcludedServices([]);
    }
    setAnalyzing(true);
    setError(null);
    try {
      const res = await fetch(`${GATEWAY}/api/integrations/onboarding/recommendations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          includedServices: splitList(includeDraft),
          missingServices: splitList(missingDraft),
          excludedServices: nextExcludedServices,
          codingAgents,
          maxEmails: 1000,
        }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) {
        setError("Suggestions are unavailable.");
        return;
      }
      const data = await res.json();
      setPlan({
        analyzedEmailCount: Number(data.analyzedEmailCount ?? 0),
        analyzedCalendarEventCount: Number(data.analyzedCalendarEventCount ?? 0),
        detectedServices: Array.isArray(data.detectedServices) ? data.detectedServices : [],
        recommendations: Array.isArray(data.recommendations) ? data.recommendations : [],
        warnings: Array.isArray(data.warnings) ? data.warnings : [],
      });
    } catch (err) {
      if (shouldLogSetupWarning(err)) {
        console.warn("[onboarding] recommendation analysis failed:", err instanceof Error ? err.message : err);
      }
      setError("Suggestions are unavailable.");
    } finally {
      setAnalyzing(false);
    }
  }, [codingAgents, excludedServices, includeDraft, missingDraft]);

  return (
    <div className="w-full max-w-5xl px-5 py-6 md:px-8">
      <div className="grid gap-6 lg:grid-cols-[minmax(0,0.95fr)_minmax(320px,1.05fr)]">
        <section className="min-w-0 space-y-5">
          <div className="space-y-3">
            <p className="text-[11px] uppercase tracking-[0.24em] text-muted-foreground/70">First run</p>
            <h1
              className="text-3xl md:text-5xl font-light leading-tight text-foreground"
              style={{ fontFamily: "var(--font-serif), Georgia, serif" }}
            >
              Shape Matrix around your work.
            </h1>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            {CONNECT_SERVICES.map((service) => {
              const Icon = service.icon;
              const isConnected = connectedIds.includes(service.id);
              const isConnecting = connecting === service.id;
              return (
                <button
                  key={service.id}
                  type="button"
                  onClick={() => handleConnect(service.id)}
                  disabled={disabled || connecting !== null || isConnected}
                  className="flex min-h-[84px] items-center gap-3 rounded-lg border border-border/70 bg-card/40 px-4 py-3 text-left transition-colors hover:border-foreground/30 hover:bg-card/70 disabled:cursor-default disabled:opacity-80"
                >
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-foreground text-background">
                    <Icon className="size-5" aria-hidden="true" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-foreground">{service.label}</span>
                    <span className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                      {isConnected ? (
                        <>
                          <Check className="size-3.5 text-emerald-500" aria-hidden="true" />
                          Connected
                        </>
                      ) : isConnecting ? (
                        <>
                          <RefreshCw className="size-3.5 animate-spin" aria-hidden="true" />
                          Waiting
                        </>
                      ) : (
                        <>
                          <ExternalLink className="size-3.5" aria-hidden="true" />
                          Connect
                        </>
                      )}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-2">
              <span className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Include</span>
              <input
                value={includeDraft}
                onChange={(event) => setIncludeDraft(event.target.value)}
                placeholder="Linear, Todoist, Figma"
                className="w-full rounded-lg border border-border/70 bg-background/80 px-3 py-2 text-sm outline-none transition focus:border-foreground/40"
              />
            </label>
            <label className="space-y-2">
              <span className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Missing</span>
              <input
                value={missingDraft}
                onChange={(event) => setMissingDraft(event.target.value)}
                placeholder="Raycast, Readwise"
                className="w-full rounded-lg border border-border/70 bg-background/80 px-3 py-2 text-sm outline-none transition focus:border-foreground/40"
              />
            </label>
          </div>

          <div className="space-y-2">
            <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
              <Bot className="size-4" aria-hidden="true" />
              Coding agents
            </div>
            <div className="flex flex-wrap gap-2">
              {CODING_AGENTS.map((agent) => {
                const selected = codingAgents.includes(agent.id);
                return (
                  <button
                    key={agent.id}
                    type="button"
                    onClick={() => toggleCodingAgent(agent.id)}
                    className={`rounded-lg border px-3 py-2 text-xs font-medium transition-colors ${
                      selected
                        ? "border-foreground bg-foreground text-background"
                        : "border-border/70 bg-card/30 text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {agent.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex flex-wrap gap-2 pt-1">
            <button
              type="button"
              onClick={() => {
                void handleAnalyze();
              }}
              disabled={disabled || analyzing || loadingConnections}
              className="inline-flex items-center gap-2 rounded-lg bg-foreground px-4 py-2.5 text-sm font-medium text-background transition hover:bg-foreground/90 disabled:opacity-60"
            >
              {analyzing ? <RefreshCw className="size-4 animate-spin" aria-hidden="true" /> : <Sparkles className="size-4" aria-hidden="true" />}
              Suggest setup
            </button>
            <button
              type="button"
              onClick={onStartVoice}
              disabled={disabled}
              className="inline-flex items-center gap-2 rounded-lg border border-border/70 px-4 py-2.5 text-sm font-medium text-foreground transition hover:border-foreground/30 disabled:opacity-60"
            >
              <Mic className="size-4" aria-hidden="true" />
              Talk to Aoede
            </button>
            <button
              type="button"
              onClick={onStartText}
              disabled={disabled}
              className="inline-flex items-center gap-2 rounded-lg border border-border/70 px-4 py-2.5 text-sm font-medium text-muted-foreground transition hover:border-foreground/30 hover:text-foreground disabled:opacity-60"
            >
              <Terminal className="size-4" aria-hidden="true" />
              Text intro
            </button>
          </div>

          {error && (
            <div className="rounded-lg border border-destructive/25 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}
        </section>

        <aside className="min-h-[360px] rounded-lg border border-border/70 bg-card/35 p-4 md:min-h-[520px] md:p-5">
          {!plan ? (
            <div className="flex h-full flex-col justify-between">
              <div className="space-y-4">
                <div className="flex size-11 items-center justify-center rounded-lg bg-foreground text-background">
                  <Sparkles className="size-5" aria-hidden="true" />
                </div>
                <div className="space-y-2">
                  <h2 className="text-lg font-medium text-foreground">Personal setup</h2>
                  <p className="max-w-sm text-sm leading-6 text-muted-foreground">
                    Connect context, name anything missing, and Matrix will assemble the first workflows, apps, skills, and routines.
                  </p>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">
                <div className="rounded-lg border border-border/60 p-3">
                  <div className="text-2xl font-light text-foreground">1000</div>
                  recent emails
                </div>
                <div className="rounded-lg border border-border/60 p-3">
                  <div className="text-2xl font-light text-foreground">4</div>
                  agent options
                </div>
              </div>
            </div>
          ) : (
            <div className="space-y-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-lg font-medium text-foreground">Suggested setup</h2>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {plan.analyzedEmailCount} emails · {plan.analyzedCalendarEventCount} calendar events
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    void handleAnalyze({ preserveExcludedServices: true });
                  }}
                  disabled={analyzing}
                  className="inline-flex size-9 items-center justify-center rounded-lg border border-border/70 text-muted-foreground transition hover:text-foreground disabled:opacity-60"
                  title="Refresh suggestions"
                >
                  <RefreshCw className={`size-4 ${analyzing ? "animate-spin" : ""}`} aria-hidden="true" />
                </button>
              </div>

              {plan.detectedServices.length > 0 && (
                <div className="space-y-2">
                  <div className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Detected</div>
                  <div className="flex flex-wrap gap-2">
                    {plan.detectedServices.map((service) => {
                      const excluded = excludedServices.includes(service.id);
                      return (
                        <button
                          type="button"
                          key={service.id}
                          onClick={() => toggleDetectedService(service.id)}
                          className={`rounded-lg border px-2.5 py-1.5 text-xs transition-colors ${
                            excluded
                              ? "border-border/60 text-muted-foreground line-through"
                              : "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                          }`}
                        >
                          {service.name}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              <div className="space-y-3">
                {plan.recommendations.slice(0, 6).map((rec) => (
                  <div key={rec.id} className="rounded-lg border border-border/60 bg-background/65 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="rounded-md bg-muted px-2 py-1 text-[11px] font-medium text-muted-foreground">
                        {categoryLabel(rec.category)}
                      </span>
                      <span className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground/70">{rec.priority}</span>
                    </div>
                    <h3 className="mt-3 text-sm font-medium text-foreground">{rec.title}</h3>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">{rec.description}</p>
                    {rec.matrixReplacement && (
                      <p className="mt-2 text-xs text-emerald-700 dark:text-emerald-300">
                        {rec.matrixReplacement}
                      </p>
                    )}
                  </div>
                ))}
              </div>

              {plan.warnings.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  Some context was unavailable; suggestions are using the signals Matrix could safely read.
                </p>
              )}

              <div className="grid gap-2 sm:grid-cols-2">
                <button
                  type="button"
                  onClick={onStartVoice}
                  disabled={disabled}
                  className="inline-flex items-center justify-center gap-2 rounded-lg bg-foreground px-4 py-2.5 text-sm font-medium text-background transition hover:bg-foreground/90 disabled:opacity-60"
                >
                  Voice intro
                  <ArrowRight className="size-4" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  onClick={onStartText}
                  disabled={disabled}
                  className="inline-flex items-center justify-center gap-2 rounded-lg border border-border/70 px-4 py-2.5 text-sm font-medium text-foreground transition hover:border-foreground/30 disabled:opacity-60"
                >
                  <Terminal className="size-4" aria-hidden="true" />
                  Text intro
                </button>
              </div>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
