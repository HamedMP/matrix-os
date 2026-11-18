import React, { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Bot, ChevronLeft, Plus, Sparkles } from "lucide-react";
import { Button } from "../Button.js";
import { ChatPromptInput } from "../chat/composer/ChatPromptInput.js";
import {
  createHostedBotsClient,
  isHostedBotRunActive,
  type HostedBot,
  type HostedBotRun,
  type HostedBotRunMode,
  type HostedBotSummary,
  type HostedBotThread,
  type HostedBotThreadDetails,
  type HostedBotsTransport,
} from "./hosted-bots-client.js";

const border = { borderColor: "var(--border-default, var(--border))" };
const muted = { color: "var(--text-secondary, var(--muted-foreground))" };
const pollDelayMs = 1250;
const maxNameLength = 80;
const maxMessageLength = 4000;

export function BotsWorkspace({ transport, active }: { transport: HostedBotsTransport | null; active: boolean }) {
  if (!transport) return <p className="m-auto p-6 text-sm" role="status">Bots is unavailable on this Computer.</p>;
  return <HostedBotsPanel transport={transport} active={active} />;
}

function HostedBotsPanel({ transport, active }: { transport: HostedBotsTransport; active: boolean }) {
  const client = useMemo(() => createHostedBotsClient(transport), [transport]);
  const [bots, setBots] = useState<HostedBotSummary[]>();
  const [selectedId, setSelectedId] = useState<string>();
  const [creating, setCreating] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [model, setModel] = useState<boolean>();
  const [modelOpen, setModelOpen] = useState(false);

  useEffect(() => {
    if (!active) return;
    let current = true;
    void client.list().then((list) => {
      if (current) setBots(list);
    }, () => {
      if (current) setError("Bots could not load. Try again.");
    });
    void client.getModel().then((data) => {
      if (current) setModel(data.connected);
    }, () => {
      if (current) setModel(undefined);
    });
    return () => { current = false; };
  }, [active, attempt, client]);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = String(new FormData(event.currentTarget).get("name") ?? "").trim();
    if (!name || pending) return;
    setPending(true);
    setError("");
    try {
      const created = await client.createBot(name);
      setBots((current) => [...(current ?? []), created]);
      setSelectedId(created.id);
      setCreating(false);
    } catch (cause: unknown) {
      console.warn("[hosted-bots] Create failed", cause instanceof Error ? cause.name : "UnknownError");
      setError("The Bot could not be created. Try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div
      className="@container flex h-full min-h-0 w-full min-w-0 flex-1 overflow-hidden"
      style={{ background: "var(--bg-app, var(--background))", color: "var(--text-primary, var(--foreground))" }}
    >
      <aside
        aria-label="Bots list"
        className={selectedId || creating || modelOpen
          ? "hidden min-h-0 w-full shrink-0 flex-col border-r @[36rem]:flex @[36rem]:w-52"
          : "flex min-h-0 w-full shrink-0 flex-col border-r @[36rem]:w-52"}
        style={{ ...border, background: "var(--bg-sidebar, var(--bg-surface))" }}
      >
        <div className="flex items-center justify-between gap-1 px-3 pt-3">
          <h2 className="flex items-center gap-2 text-sm font-semibold"><Bot size={17} aria-hidden="true" /> Bots</h2>
          <Button size="icon" variant="ghost" aria-label="New Bot" disabled={pending || !bots} onClick={() => { setCreating(true); setModelOpen(false); setError(""); }}>
            <Plus size={17} aria-hidden="true" />
          </Button>
        </div>
        <div className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2 pb-3">
          {!bots && !error ? <p className="px-2 py-3 text-xs @[36rem]:hidden" style={muted} role="status">Loading Bots…</p> : null}
          {bots?.length === 0 && !creating ? <p className="px-2 py-3 text-xs" style={muted}>Your Bots will appear here.</p> : null}
          {bots?.map((bot) => (
            <button
              type="button"
              key={bot.id}
              aria-pressed={selectedId === bot.id}
              className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm hover:bg-[var(--bg-hover)] aria-pressed:bg-[var(--bg-selected,var(--accent-muted))]"
              onClick={() => { setSelectedId(bot.id); setCreating(false); setModelOpen(false); setError(""); }}
            >
              <Bot size={16} className="shrink-0" aria-hidden="true" />
              <span className="truncate">{bot.name}</span>
            </button>
          ))}
        </div>
        <div className="border-t p-2" style={border}>
          <Button variant="ghost" size="sm" onClick={() => { setModelOpen(true); setCreating(false); }}>
            {model ? "Model connected" : "Connect model"}
          </Button>
        </div>
        {error && !creating ? (
          <div className="space-y-2 px-3 pb-3">
            <p className="text-xs" role="alert">{error}</p>
            {!bots ? <Button size="sm" variant="secondary" onClick={() => { setError(""); setAttempt((current) => current + 1); }}>Retry</Button> : null}
          </div>
        ) : null}
      </aside>
      {modelOpen ? (
        <ModelConnection client={client} connected={model} onBack={() => setModelOpen(false)} onConnected={() => setModel(true)} />
      ) : creating ? (
        <section className="flex min-w-0 flex-1 items-center justify-center overflow-y-auto p-6">
          <form className="w-full max-w-sm space-y-4" onSubmit={(event) => void create(event)}>
            <header>
              <h1 className="text-xl font-semibold">New Bot</h1>
              <p className="mt-1 text-sm" style={muted}>Give your Bot a name, then tell it what to do in a conversation.</p>
              {error ? <p className="mt-2 text-sm" role="alert">{error}</p> : null}
            </header>
            <label className="block text-sm">
              <span className="mb-1 block font-medium">Bot name</span>
              <input name="name" required maxLength={maxNameLength} placeholder="e.g. Pebble" className="w-full rounded-lg border bg-transparent px-3 py-2" style={border} />
            </label>
            <div className="flex gap-2">
              <Button type="submit" disabled={pending}>{pending ? "Creating…" : "Create Bot"}</Button>
              <Button variant="ghost" disabled={pending} onClick={() => setCreating(false)}>Cancel</Button>
            </div>
          </form>
        </section>
      ) : selectedId ? (
        <BotConversation key={selectedId} botId={selectedId} client={client} active={active} model={model} onModel={() => setModelOpen(true)} onBack={() => setSelectedId(undefined)} />
      ) : (
        <section className="hidden flex-1 flex-col items-center justify-center gap-2 p-6 text-center @[36rem]:flex">
          <span className="rounded-xl bg-[var(--accent-muted)] p-3" aria-hidden="true"><Bot size={22} /></span>
          <h1 className="text-xl font-semibold">{bots ? "Your Bots" : "Loading Bots…"}</h1>
          <p className="text-sm" style={muted}>{bots ? "Create a Bot or select one to continue a conversation." : "Getting Bots from this Computer."}</p>
        </section>
      )}
    </div>
  );
}

type Client = ReturnType<typeof createHostedBotsClient>;

function ModelConnection({ client, connected, onBack, onConnected }: {
  client: Client;
  connected: boolean | undefined;
  onBack: () => void;
  onConnected: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);

  async function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const key = String(new FormData(form).get("apiKey") ?? "").trim();
    if (!key || pending) return;
    form.reset();
    setPending(true);
    setError(false);
    try {
      if (!(await client.connectModel(key)).connected) {
        setError(true);
        return;
      }
      onConnected();
    } catch (cause: unknown) {
      console.warn("[hosted-bots] Model connection failed", cause instanceof Error ? cause.name : "UnknownError");
      setError(true);
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="flex min-w-0 flex-1 items-center justify-center overflow-y-auto p-6">
      <form className="ph-no-capture w-full max-w-sm space-y-4" onSubmit={(event) => void connect(event)}>
        <header>
          <h1 className="text-xl font-semibold">Bot model</h1>
          <p className="mt-1 text-sm" style={muted}>{connected ? "A model is connected for Bots on this Computer." : "Connect your OpenAI account for Bots on this Computer."}</p>
        </header>
        <label className="block text-sm">
          <span className="mb-1 block font-medium">OpenAI API key</span>
          <input type="password" name="apiKey" autoComplete="off" required maxLength={256} disabled={pending}
            className="w-full rounded-lg border bg-transparent px-3 py-2" style={border} />
        </label>
        {error ? <p className="text-sm" role="alert">The model could not connect. Check your API key and try again.</p> : null}
        <div className="flex gap-2">
          <Button type="submit" disabled={pending}>{pending ? "Connecting…" : connected ? "Replace API key" : "Connect model"}</Button>
          <Button variant="ghost" disabled={pending} onClick={onBack}>Back</Button>
        </div>
      </form>
    </section>
  );
}

function BotConversation({ botId, client, active, model, onModel, onBack }: {
  botId: string;
  client: Client;
  active: boolean;
  model: boolean | undefined;
  onModel: () => void;
  onBack: () => void;
}) {
  const [details, setDetails] = useState<{ bot: HostedBot; threads: HostedBotThread[] }>();
  const [thread, setThread] = useState<HostedBotThread>();
  const [conversationVersion, setConversationVersion] = useState(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let current = true;
    void client.getBot(botId).then((data) => {
      if (!current) return;
      setDetails(data);
      setThread((previous) => previous ?? data.threads[0]);
    }, () => {
      if (current) setError("The Bot could not load. Return to Bots and try again.");
    });
    return () => { current = false; };
  }, [botId, client]);

  async function newConversation() {
    if (pending) return;
    setPending(true);
    setError("");
    try {
      const created = await client.createThread(botId);
      setDetails((current) => current && ({ ...current, threads: [created, ...current.threads] }));
      setThread(created);
      setConversationVersion((current) => current + 1);
    } catch (cause: unknown) {
      console.warn("[hosted-bots] Conversation creation failed", cause instanceof Error ? cause.name : "UnknownError");
      setError("The conversation could not be created. Try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col" aria-label="Bot conversation">
      <header className="flex flex-wrap items-center gap-2 border-b px-3 py-2" style={border}>
        <Button size="icon" variant="ghost" className="@[36rem]:hidden" aria-label="Back to Bots" onClick={onBack}><ChevronLeft size={18} aria-hidden="true" /></Button>
        <h1 className="mr-auto truncate text-sm font-semibold">{details?.bot.name ?? "Bot"}</h1>
        {details?.threads.length ? (
          <select aria-label="Conversation" value={thread?.id ?? ""} onChange={(event) => {
            setThread(details.threads.find((item) => item.id === event.target.value));
            setConversationVersion((current) => current + 1);
          }}
            className="max-w-40 rounded-lg border bg-[var(--bg-surface)] px-2 py-1.5 text-xs" style={border}>
            {details.threads.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
          </select>
        ) : null}
        {details ? <Button size="sm" variant="secondary" disabled={pending} onClick={() => void newConversation()}>New conversation</Button> : null}
      </header>
      {error ? <p className="p-3 text-sm" role="alert">{error}</p> : null}
      {details ? (
        <ConversationThread
          key={conversationVersion}
          client={client}
          bot={details.bot}
          thread={thread}
          active={active}
          model={model}
          onModel={onModel}
          onProfileChange={(updated) => setDetails((current) => current && ({ ...current, bot: updated }))}
          onThreadCreated={(created) => {
            setDetails((current) => current && ({ ...current, threads: [created, ...current.threads] }));
            setThread(created);
          }}
        />
      ) : !error ? <p className="m-auto text-sm" role="status" style={muted}>Loading Bot…</p> : null}
    </section>
  );
}

function ConversationThread({ client, bot, thread: initialThread, active, model, onModel, onProfileChange, onThreadCreated }: {
  client: Client;
  bot: HostedBot;
  thread: HostedBotThread | undefined;
  active: boolean;
  model: boolean | undefined;
  onModel: () => void;
  onProfileChange: (bot: HostedBot) => void;
  onThreadCreated: (thread: HostedBotThread) => void;
}) {
  const [thread, setThread] = useState(initialThread);
  const [snapshot, setSnapshot] = useState<HostedBotThreadDetails>();
  const [admission, setAdmission] = useState<HostedBotRun>();
  const [text, setText] = useState("");
  const [mode, setMode] = useState<HostedBotRunMode>(bot.revision ? "chat" : "setup");
  const [sending, setSending] = useState(false);
  const [readError, setReadError] = useState(false);
  const [sendError, setSendError] = useState(false);
  const [undoError, setUndoError] = useState(false);
  const [undoPending, setUndoPending] = useState(false);
  const observedChange = useRef<string | undefined>(undefined);
  const [reload, setReload] = useState(0);
  const request = useRef<{ id: string; text: string; mode: HostedBotRunMode } | undefined>(undefined);
  const end = useRef<HTMLDivElement>(null);
  const latestRun = snapshot?.runs.at(-1);
  const activeRun = admission && !snapshot?.runs.some((item) => item.id === admission.id)
    ? admission
    : latestRun;
  const busy = Boolean(activeRun && isHostedBotRunActive(activeRun));
  const lastChange = snapshot?.profileChanges[0];

  useEffect(() => {
    if (!lastChange || lastChange.undoneAt || observedChange.current === lastChange.id) return;
    observedChange.current = lastChange.id;
    setMode("chat");
    if (lastChange.revision > bot.revision) {
      void client.getBot(bot.id).then(({ bot: updated }) => onProfileChange(updated), (cause: unknown) => {
        console.warn("[hosted-bots] Profile refresh failed", cause instanceof Error ? cause.name : "UnknownError");
      });
    }
  }, [bot.id, bot.revision, client, lastChange, onProfileChange]);

  useEffect(() => {
    if (!thread || !active) return;
    const threadId = thread.id;
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function refresh() {
      try {
        const next = await client.getThread(bot.id, threadId);
        if (!current) return;
        setSnapshot(next);
        setReadError(false);
        const waitingForAdmission = admission && !next.runs.some((item) => item.id === admission.id);
        if (waitingForAdmission || next.runs.some(isHostedBotRunActive)) timer = setTimeout(() => void refresh(), pollDelayMs);
      } catch (cause: unknown) {
        if (!current) return;
        console.warn("[hosted-bots] Conversation load failed", cause instanceof Error ? cause.name : "UnknownError");
        setReadError(true);
      }
    }
    void refresh();
    return () => { current = false; clearTimeout(timer); };
  }, [active, admission, bot.id, client, reload, thread]);

  useEffect(() => {
    end.current?.scrollIntoView?.({ block: "end" });
  }, [snapshot?.messages.length, busy]);

  async function submit() {
    const body = text.trim();
    if (!body || sending || busy || readError || !model) return;
    setSending(true);
    setSendError(false);
    const previous = request.current;
    const next = previous?.text === body && previous.mode === mode
      ? previous
      : { id: crypto.randomUUID(), text: body, mode };
    request.current = next;
    try {
      let target = thread;
      if (!target) {
        target = await client.createThread(bot.id);
        setThread(target);
        onThreadCreated(target);
      }
      setAdmission(await client.submit(bot.id, target.id, { requestId: next.id, text: body, mode }));
      request.current = undefined;
      setText("");
    } catch (cause: unknown) {
      console.warn("[hosted-bots] Message admission failed", cause instanceof Error ? cause.name : "UnknownError");
      setSendError(true);
      setReload((current) => current + 1);
    } finally {
      setSending(false);
    }
  }

  async function undo(changeId: string) {
    if (undoPending || busy || sending) return;
    setUndoPending(true);
    setUndoError(false);
    try {
      onProfileChange(await client.undo(bot.id, changeId));
      setReload((current) => current + 1);
    } catch (cause: unknown) {
      console.warn("[hosted-bots] Profile undo failed", cause instanceof Error ? cause.name : "UnknownError");
      setUndoError(true);
    } finally {
      setUndoPending(false);
    }
  }

  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5" aria-label="Messages">
        <div className="mx-auto w-full max-w-2xl space-y-4">
          {!snapshot?.messages.length && !busy && (
            <div className="mx-auto max-w-sm py-8 text-center">
              <Sparkles size={23} className="mx-auto mb-2" aria-hidden="true" />
              <h2 className="text-lg font-semibold">{mode === "setup" ? "Set up " + bot.name : "Chat with " + bot.name}</h2>
              <p className="mt-1 text-sm" style={muted}>{mode === "setup" ? "Describe what your Bot should do. You can revise its instructions here later." : "Ask your Bot to do something."}</p>
            </div>
          )}
          {snapshot?.messages.map((message) => (
            <article key={message.id} aria-label={message.role === "user" ? "You" : bot.name}
              className={message.role === "user" ? "ml-auto w-fit max-w-[85%] rounded-2xl bg-[var(--bg-selected,var(--accent-muted))] px-4 py-2 text-sm" : "text-sm"}>
              <p className="whitespace-pre-wrap break-words">{message.text}</p>
            </article>
          ))}
          {busy ? <p className="text-sm" role="status" style={muted}>Running on this Computer…</p> : null}
          {activeRun?.status === "failed" ? <p className="text-sm" role="alert">This run failed. Try again.</p> : null}
          {lastChange ? (
            <div className="flex items-center justify-between gap-2 rounded-xl border p-3 text-sm" style={border}>
              <span>{lastChange.undoneAt ? "Configuration change undone" : "Bot configuration saved"}</span>
              {!lastChange.undoneAt ? <Button size="sm" variant="ghost" disabled={undoPending || busy || sending} onClick={() => void undo(lastChange.id)}>Undo</Button> : null}
            </div>
          ) : null}
          {undoError ? <p className="text-sm" role="alert">This configuration change could not be undone. Refresh and try again.</p> : null}
          <div ref={end} />
        </div>
      </div>
      <div className="px-3 pb-3 pt-1">
        <div className="mx-auto w-full max-w-2xl space-y-2">
          {readError ? (
            <div className="flex items-center gap-2 text-xs" role="alert">
              This conversation could not refresh.
              <Button variant="ghost" size="sm" onClick={() => setReload((current) => current + 1)}>Retry</Button>
            </div>
          ) : null}
          {sendError ? <p className="text-xs" role="alert">Sending could not be confirmed. Retry to check the same request.</p> : null}
          {model === false ? (
            <div className="flex items-center gap-2 text-xs" role="status">
              Connect a model to send messages.
              <Button variant="ghost" size="sm" onClick={onModel}>Connect model</Button>
            </div>
          ) : null}
          <ChatPromptInput
            value={text}
            onChange={setText}
            onSubmit={() => void submit()}
            placeholder={"Message " + bot.name}
            sendLabel="Send message"
            busy={busy || sending}
            disabled={!model || busy || sending || undoPending || readError || Boolean(thread && !snapshot)}
            maxLength={maxMessageLength}
            controls={(
              <Button size="sm" variant="ghost" aria-pressed={mode === "setup"} disabled={busy || sending} onClick={() => setMode(mode === "setup" ? "chat" : "setup")}>
                <Sparkles size={15} aria-hidden="true" />
                {mode === "setup" ? "Setting up Bot" : "Configure in chat"}
              </Button>
            )}
          />
        </div>
      </div>
    </>
  );
}
