import { botInteractionCard, type BotInteraction, type ResolveBotInteractionRequest, type ResolveBotInteractionResponse } from "@matrix-os/contracts";
import { useEffect, useState } from "react";
import { chatAgentButtonClass, chatAgentMutedStyle } from "../theme.js";

export function InteractionCard({ interaction, onResolve, onResolved, onConnectUrl }: {
  interaction: BotInteraction;
  onResolve: (request: ResolveBotInteractionRequest) => Promise<ResolveBotInteractionResponse | void>;
  onResolved?: () => void;
  onConnectUrl?: (url: string) => void;
}) {
  const [now, setNow] = useState(() => new Date().toISOString());
  const [answer, setAnswer] = useState("");
  const [pending, setPending] = useState(false);
  const [resolved, setResolved] = useState(false);
  const [error, setError] = useState("");
  const [connectUrl, setConnectUrl] = useState<string | null>(null);
  useEffect(() => {
    if (interaction.status !== "pending") return;
    const delay = Date.parse(interaction.expiresAt) - Date.now();
    if (delay <= 0) { setNow(new Date().toISOString()); return; }
    const timer = setTimeout(() => setNow(new Date().toISOString()), Math.min(delay + 1, 2_147_483_647));
    return () => clearTimeout(timer);
  }, [interaction.expiresAt, interaction.status]);
  const card = botInteractionCard(interaction, now);
  const actionable = card.state === "actionable" && !resolved;

  const decide = async (request: ResolveBotInteractionRequest) => {
    if (!actionable || pending) return;
    setPending(true);
    setError("");
    try {
      const response = await onResolve(request);
      if (response?.connectUrl) {
        setConnectUrl(response.connectUrl);
        onConnectUrl?.(response.connectUrl);
      }
      setResolved(true);
      onResolved?.();
    } catch (failure: unknown) {
      console.warn("[chat-agents] Bot interaction failed:", failure instanceof Error ? failure.name : "UnknownError");
      setError("Could not save your response. Refresh and try again.");
    } finally {
      setPending(false);
    }
  };
  const payload = interaction.payload;
  return <section aria-label={card.title} className="matrix-chat-agent-card grid gap-3 rounded-2xl border p-4">
    <div><h3 className="text-sm font-semibold">{card.title}</h3>
      {!actionable ? <p role="status" className="mt-1 text-xs" style={chatAgentMutedStyle}>{resolved ? "Resolved" : card.state === "unavailable" ? "Only the designated person can respond." : card.state}</p> : null}</div>
    {actionable && payload?.kind === "question" ? <>
      {payload.questions.map((question) => <p key={question.questionId} className="text-sm">{question.question}</p>)}
      <label className="grid gap-1 text-xs">Answer
        <textarea aria-label="Answer" value={answer} maxLength={30_000} disabled={pending} onChange={(event) => setAnswer(event.currentTarget.value)}
          className="min-h-20 w-full rounded-lg border bg-transparent p-2 text-sm" /></label>
      <button type="button" className={`${chatAgentButtonClass} justify-self-start`} disabled={pending || !answer.trim()}
        onClick={() => { void decide({ kind: "question", baseRevision: interaction.revision, answer: answer.trim() }); }}>Answer</button>
    </> : null}
    {actionable && payload?.kind === "account_choice" ? <div className="flex flex-wrap gap-2">
      {payload.options.map((option) => <button key={option.connectionId} type="button" className={chatAgentButtonClass} disabled={pending}
        onClick={() => { void decide({ kind: "account_choice", baseRevision: interaction.revision, connectionId: option.connectionId }); }}>{option.label}</button>)}
    </div> : null}
    {actionable && payload?.kind === "connect_request" ? <>
      <p className="text-sm">{payload.benefit}</p><p className="text-xs" style={chatAgentMutedStyle}>Requested access: {payload.access.join(", ")}</p>
      <div className="flex flex-wrap gap-2">{(["start", "decline"] as const).map((action) => <button key={action} type="button"
        className={chatAgentButtonClass} disabled={pending} onClick={() => { void decide({ kind: "connect_request", baseRevision: interaction.revision, action }); }}>
        {action === "start" ? "Connect" : "Decline"}</button>)}</div>
    </> : null}
    {actionable && payload?.kind === "approval" ? <>
      <p className="whitespace-pre-wrap text-sm">{payload.preview}</p>
      <div className="flex flex-wrap gap-2">{(["approve", "deny"] as const).map((decision) => <button key={decision} type="button"
        className={chatAgentButtonClass} disabled={pending} onClick={() => { void decide({ kind: "approval", baseRevision: interaction.revision, decision }); }}>
        {decision === "approve" ? "Approve" : "Deny"}</button>)}</div>
    </> : null}
    {error ? <p role="alert" className="text-xs">{error}</p> : null}
    {connectUrl ? <a className={chatAgentButtonClass} href={connectUrl} rel="noopener noreferrer">Continue connecting</a> : null}
  </section>;
}
