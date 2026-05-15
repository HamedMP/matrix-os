import { useCallback, useEffect, useMemo, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Bot, CheckCircle2, CircleAlert, KeyRound, MessageSquareText, PlugZap, RefreshCw, Send, Settings, ShieldCheck, SquareActivity } from "lucide-react";
import { hermesApi, type HermesConfig, type HermesEvent, type HermesStatus } from "./lib/api";
import { channelById, readinessLabel, readinessTone, stepProgress } from "./lib/view-model";

function toneClass(tone: string): string {
  if (tone === "ok") return "bg-emerald-100 text-emerald-800";
  if (tone === "warn") return "bg-amber-100 text-amber-900";
  return "bg-rose-100 text-rose-800";
}

function Button(props: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button {...props} className={`inline-flex h-9 items-center justify-center gap-2 rounded-md border border-slate-300 bg-white px-3 text-sm font-medium text-slate-900 shadow-sm hover:bg-slate-50 disabled:opacity-50 ${props.className ?? ""}`} />;
}

function Panel({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-900">{icon}<h2>{title}</h2></div>
      {children}
    </section>
  );
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export default function App() {
  const [status, setStatus] = useState<HermesStatus | null>(null);
  const [config, setConfig] = useState<HermesConfig | null>(null);
  const [events, setEvents] = useState<HermesEvent[]>([]);
  const [modelSecret, setModelSecret] = useState("");
  const [prompt, setPrompt] = useState("Summarize my connected channels and current setup.");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef<string | null>(null);

  const load = useCallback(async (options: { clearError?: boolean } = {}) => {
    if (options.clearError ?? true) setError(null);
    const [nextStatus, nextConfig] = await Promise.all([hermesApi.status(), hermesApi.config()]);
    setStatus(nextStatus);
    setConfig(nextConfig);
  }, []);

  useEffect(() => {
    void load().catch((err: unknown) => {
      console.error("[hermes-manager] Initial load failed:", describeError(err));
      setError("Hermes Manager could not load.");
    });
  }, [load]);

  useEffect(() => {
    if (typeof EventSource === "undefined") return undefined;
    const source = new EventSource("/api/hermes/events");
    const refresh = () => void load({ clearError: false }).catch((err: unknown) => {
      console.warn("[hermes-manager] Event refresh failed:", describeError(err));
    });
    const onSession = (event: MessageEvent) => {
      try {
        const parsed = JSON.parse(event.data) as HermesEvent;
        setEvents((current) => [...current, parsed].slice(-100));
      } catch (err: unknown) {
        console.warn("[hermes-manager] Event parse failed:", err instanceof Error ? err.message : String(err));
        setError("Hermes sent an unreadable event.");
      }
    };
    source.addEventListener("status.updated", refresh);
    source.addEventListener("channel.updated", refresh);
    source.addEventListener("approval.updated", refresh);
    source.addEventListener("operator.event", refresh);
    source.addEventListener("session.event", onSession);
    source.onerror = (err) => {
      console.warn("[hermes-manager] Event stream disconnected:", err);
    };
    return () => source.close();
  }, [load]);

  const progress = stepProgress(config);
  const telegram = channelById(config?.channels ?? [], "telegram");
  const whatsapp = channelById(config?.channels ?? [], "whatsapp");
  const activeSession = useMemo(() => {
    const sessions = config?.sessions ?? [];
    return [...sessions]
      .filter((session) => ["idle", "starting", "streaming", "waiting_approval"].includes(session.status))
      .sort((left, right) => Date.parse(right.lastActiveAt ?? right.updatedAt) - Date.parse(left.lastActiveAt ?? left.updatedAt))[0] ?? null;
  }, [config?.sessions]);
  const pendingApproval = config?.approvals.find((approval) => approval.status === "pending") ?? null;
  const tone = readinessTone(status?.readiness ?? "missing");
  const isBusy = busy !== null;

  const setupCopy = useMemo(() => {
    if (!status) return "Checking Hermes";
    if (status.readiness === "ready") return "Hermes is ready to orchestrate Matrix.";
    if (status.readiness === "missing") return "Connect the local Hermes repo and model provider.";
    return "Finish setup and verify the gateway.";
  }, [status]);

  async function run(label: string, action: () => Promise<unknown>) {
    if (busyRef.current !== null) return;
    busyRef.current = label;
    setBusy(label);
    setError(null);
    try {
      try {
        await action();
      } catch (err: unknown) {
        console.error("[hermes-manager] Action failed:", label, describeError(err));
        setError("Action failed. Check Hermes status and try again.");
        return;
      }
      try {
        await load();
      } catch (err: unknown) {
        console.warn("[hermes-manager] Refresh after action failed:", label, describeError(err));
        setError("Action completed, but refresh failed. Check Hermes status.");
      }
    } finally {
      busyRef.current = null;
      setBusy(null);
    }
  }

  function refreshManually() {
    void load().catch((err: unknown) => {
      console.error("[hermes-manager] Manual refresh failed:", describeError(err));
      setError("Refresh failed. Check Hermes status.");
    });
  }

  return (
    <main className="flex h-screen min-h-0 flex-col bg-slate-100 text-slate-950">
      <header className="flex shrink-0 items-center justify-between border-b border-slate-200 bg-white px-5 py-3">
        <div className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-lg bg-emerald-700 text-white"><Bot size={22} /></div>
          <div>
            <h1 className="text-lg font-semibold leading-tight">Hermes Manager</h1>
            <p className="text-sm text-slate-600">{setupCopy}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className={`rounded-full px-3 py-1 text-xs font-semibold capitalize ${toneClass(tone)}`}>{readinessLabel(status)}</span>
          <Button disabled={isBusy} onClick={refreshManually}><RefreshCw size={16} />Refresh</Button>
        </div>
      </header>

      {error ? <div className="mx-5 mt-4 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">{error}</div> : null}

      <div className="grid min-h-0 flex-1 grid-cols-[360px_1fr] gap-4 overflow-hidden p-5">
        <div className="flex min-h-0 flex-col gap-4 overflow-y-auto">
          <Panel title="Onboarding" icon={<ShieldCheck size={17} />}>
            <div className="mb-3 flex items-center justify-between text-sm">
              <span>{progress.complete} of {progress.total} steps complete</span>
              <span className="text-slate-500">{status?.gatewayStatus ?? "unknown"}</span>
            </div>
            <div className="space-y-2">
              {(config?.setupSteps ?? []).map((step) => (
                <div key={step.id} className="flex items-start gap-2 rounded-md bg-slate-50 p-2 text-sm">
                  {step.status === "complete" ? <CheckCircle2 className="mt-0.5 text-emerald-700" size={16} /> : <CircleAlert className="mt-0.5 text-amber-700" size={16} />}
                  <div><div className="font-medium">{step.title}</div><div className="text-slate-600">{step.detail}</div></div>
                </div>
              ))}
            </div>
            <div className="mt-3 grid gap-2">
              {!config?.installation ? (
                <Button disabled={isBusy} onClick={() => run("setup", () => hermesApi.saveConfig({ defaultProfileId: "default", authorizedOperators: [] }))}>
                  <CheckCircle2 size={16} />Initialize Hermes
                </Button>
              ) : null}
              <input aria-label="Model provider secret" type="password" autoComplete="off" value={modelSecret} onChange={(event) => setModelSecret(event.target.value)} placeholder="Model provider secret" className="h-9 rounded-md border border-slate-300 px-3 text-sm" />
              <Button disabled={!modelSecret || isBusy} onClick={() => run("model", async () => {
                await hermesApi.saveModelCredential({ providerId: "anthropic", secret: modelSecret });
                setModelSecret("");
              })}><KeyRound size={16} />Save Model Key</Button>
            </div>
          </Panel>

          <Panel title="Channels" icon={<PlugZap size={17} />}>
            {[telegram, whatsapp].map((channel) => (
              <div key={channel.id} className="mb-3 rounded-md border border-slate-200 p-3">
                <div className="mb-2 flex items-center justify-between">
                  <div className="font-medium capitalize">{channel.id}</div>
                  <span className={`rounded-full px-2 py-1 text-xs ${toneClass(channel.status === "connected" ? "ok" : channel.status === "disabled" ? "warn" : "bad")}`}>{channel.status}</span>
                </div>
                <p className="mb-3 text-sm text-slate-600">{channel.allowedSenderPolicy}</p>
                <div className="flex flex-wrap gap-2">
                  <Button disabled={isBusy} onClick={() => run(`${channel.id}-connect`, () => hermesApi.channelAction(channel.id as "telegram" | "whatsapp", channel.id === "whatsapp" ? "start_pairing" : "connect"))}>Connect</Button>
                  <Button disabled={isBusy} onClick={() => run(`${channel.id}-verify`, () => hermesApi.channelAction(channel.id as "telegram" | "whatsapp", "verify"))}>Verify</Button>
                  <Button disabled={isBusy} onClick={() => run(`${channel.id}-disable`, () => hermesApi.channelAction(channel.id as "telegram" | "whatsapp", channel.enabled ? "disable" : "enable"))}>{channel.enabled ? "Disable" : "Enable"}</Button>
                </div>
              </div>
            ))}
          </Panel>
        </div>

        <div className="grid min-h-0 grid-rows-[1fr_auto] gap-4 overflow-hidden">
          <div className="grid min-h-0 grid-cols-[1fr_320px] gap-4 overflow-hidden">
            <Panel title="Conversation" icon={<MessageSquareText size={17} />}>
              <div className="flex h-full min-h-0 flex-col">
                <div className="min-h-0 flex-1 overflow-y-auto rounded-md bg-slate-950 p-3 text-sm text-slate-100">
                  {events.length === 0 ? <div className="text-slate-400">Hermes session events will appear here.</div> : events.map((event) => (
                    <div key={event.id} className="mb-2 rounded bg-slate-900 p-2">
                      <div className="text-xs text-slate-400">{event.type}</div>
                      <pre className="whitespace-pre-wrap break-words font-mono text-xs">{JSON.stringify(event.payload, null, 2)}</pre>
                    </div>
                  ))}
                </div>
                <div className="mt-3 flex gap-2">
                  <input aria-label="Message Hermes" value={prompt} onChange={(event) => setPrompt(event.target.value)} className="h-10 flex-1 rounded-md border border-slate-300 px-3 text-sm" />
                  <Button disabled={!prompt || isBusy} onClick={() => run("prompt", () => activeSession ? hermesApi.sendPrompt(activeSession.id, prompt) : hermesApi.createSession({ prompt, profileId: config?.installation?.defaultProfileId ?? "default", modelId: config?.installation?.defaultModelId }))}><Send size={16} />Send</Button>
                </div>
              </div>
            </Panel>

            <div className="flex min-h-0 flex-col gap-4 overflow-y-auto">
              <Panel title="Operations" icon={<SquareActivity size={17} />}>
                <div className="grid gap-2">
                  <Button disabled={isBusy} onClick={() => run("health", () => hermesApi.gatewayAction("health_check"))}>Health Check</Button>
                  <Button disabled={isBusy} onClick={() => run("restart", () => hermesApi.gatewayAction("restart"))}>Restart Gateway</Button>
                  <Button disabled={isBusy} onClick={() => run("update", () => hermesApi.gatewayAction("update"))}>Update Hermes</Button>
                  <Button disabled={isBusy} onClick={() => run("recover", () => hermesApi.recover())}>Recover Stale State</Button>
                </div>
              </Panel>

              <Panel title="Approvals" icon={<Settings size={17} />}>
                {pendingApproval ? (
                  <div className="space-y-3 text-sm">
                    <p>{pendingApproval.description}</p>
                    <div className="flex gap-2">
                      <Button disabled={isBusy} onClick={() => run("approve", () => hermesApi.decideApproval(pendingApproval.id, "approved"))}>Approve</Button>
                      <Button disabled={isBusy} onClick={() => run("deny", () => hermesApi.decideApproval(pendingApproval.id, "denied"))}>Deny</Button>
                    </div>
                  </div>
                ) : <p className="text-sm text-slate-600">No pending approvals.</p>}
              </Panel>
            </div>
          </div>

          <Panel title="Audit" icon={<CircleAlert size={17} />}>
            <div className="grid max-h-32 grid-cols-3 gap-2 overflow-y-auto text-sm">
              {(config?.events ?? []).slice(-6).map((event) => (
                <div key={event.id} className="rounded-md bg-slate-50 p-2">
                  <div className="font-medium">{event.category}</div>
                  <div className="text-slate-600">{event.message}</div>
                </div>
              ))}
            </div>
          </Panel>
        </div>
      </div>
    </main>
  );
}
