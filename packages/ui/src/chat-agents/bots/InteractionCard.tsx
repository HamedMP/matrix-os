import { botSavedAnswerRecovery, botInteractionCard, botIntegrationAccessCopy, type BotInteraction, type ResolveBotInteractionRequest, type ResolveBotInteractionResponse } from "@matrix-os/contracts";
import { useEffect, useState } from "react";
import { chatAgentButtonClass, chatAgentMutedStyle } from "../theme.js";
import { routineApprovalPreview } from "./routine-presentation.js";
import { RoutineApprovalDetails } from "./RoutineApprovalDetails.js";

const MAX_STRUCTURED_ANSWER_BYTES = 700;
const encoder = new TextEncoder();

export function InteractionCard({ interaction, onResolve, onResolved, actionsAvailable = true, agentName }: {
  agentName?: string;
  interaction: BotInteraction;
  onResolve: (request: ResolveBotInteractionRequest) => Promise<ResolveBotInteractionResponse | void>;
  onResolved?: () => void;
  actionsAvailable?: boolean;
}) {
  const [now, setNow] = useState(() => new Date().toISOString());
  const [selectedAnswers, setSelectedAnswers] = useState<Record<string, string[]>>({});
  const [typedAnswers, setTypedAnswers] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const [resolved, setResolved] = useState(false);
  const [savedRevision, setSavedRevision] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [connectUrl, setConnectUrl] = useState<string | null>(null);
  useEffect(() => {
    if (interaction.status !== "pending" && !interaction.recoveryAvailable && savedRevision === null) return;
    const delay = Date.parse(interaction.expiresAt) - Date.now();
    if (delay <= 0) { setNow(new Date().toISOString()); return; }
    const timer = setTimeout(() => setNow(new Date().toISOString()), Math.min(delay + 1, 2_147_483_647));
    return () => clearTimeout(timer);
  }, [interaction.expiresAt, interaction.status, interaction.recoveryAvailable, savedRevision]);
  const payload = interaction.payload;
  const card = botInteractionCard(interaction, now);
  const isRoutine = payload?.kind === "approval" && payload.tool === "routine.activate";
  const routine = isRoutine && payload.kind === "approval" ? routineApprovalPreview(payload.preview) : null;
  const title = routine ? `${routine.source.routineId ? "Update schedule" : "Schedule"} ${routine.proposal.name}` : card.title;
  const recovery = !resolved ? botSavedAnswerRecovery(interaction, now, savedRevision) : null;
  const recoveryOpen = recovery !== null && !recovery.expired;
  const actionable = card.state === "actionable" && !resolved && actionsAvailable && (!isRoutine || routine !== null);

  const decide = async (request: ResolveBotInteractionRequest) => {
    if (pending || (request.kind === "resume" ? !recoveryOpen || !actionsAvailable : !actionable)) return;
    setPending(true);
    setError("");
    try {
      const response = await onResolve(request);
      if (response?.continuationPending) {
        setSavedRevision(response.interaction.revision);
        onResolved?.();
        return;
      }
      setSavedRevision(null);
      if (response?.connectUrl) setConnectUrl(response.connectUrl);
      setResolved(true);
      // Keep the returned consent link visible until the next status refresh.
      if (!response?.connectUrl) onResolved?.();
    } catch (failure: unknown) {
      console.warn("[chat-agents] Bot interaction failed:", failure instanceof Error ? failure.name : "UnknownError");
      setError(request.kind === "resume" ? "Your answer is saved. Work could not resume. Refresh and try again." : "Could not save your response. Refresh and try again.");
    } finally {
      setPending(false);
    }
  };
  if (recovery) return <section aria-label="Saved answer" className="matrix-chat-agent-card matrix-bot-interaction-card grid gap-3 rounded-xl border p-4">
    <p className="text-sm">Your answer is saved. Resuming work is pending confirmation.</p>
    {!recoveryOpen ? <p role="status">This request has expired.</p> : null}
    {error ? <p role="alert">{error}</p> : null}
    <button type="button" className={chatAgentButtonClass} disabled={!recoveryOpen || !actionsAvailable || pending}
      onClick={() => void decide({ kind: "resume", baseRevision: recovery.revision })}>Resume</button>
  </section>;

  const typeAnswer = (questionId: string, value: string) => {
    setTypedAnswers((current) => ({ ...current, [questionId]: value }));
    // Keep the last radio choice underneath Other so clearing Other restores it.
  };
  const access = payload?.kind === "connect_request" || (payload?.kind === "account_choice" && payload.access)
    ? botIntegrationAccessCopy(payload.service, payload.access!) : null;
  const questionAnswers = payload?.kind === "question"
    ? Object.fromEntries(payload.questions.map((question) => {
        const typed = typedAnswers[question.questionId]?.trim();
        const selected = selectedAnswers[question.questionId] ?? [];
        return [question.questionId, question.multiSelect
          ? [...selected, ...(typed ? [typed] : [])] : typed ? [typed] : selected.slice(0, 1)];
      })) as Record<string, string[]>
    : {};
  const answerTooLong = Object.values(questionAnswers).some((values) => values.some((value) => (
    encoder.encode(value).byteLength > MAX_STRUCTURED_ANSWER_BYTES
  )));
  const allQuestionsAnswered = payload?.kind === "question" && !answerTooLong
    && payload.questions.every((question) => questionAnswers[question.questionId]?.length);
  return <section aria-label={title} className="matrix-chat-agent-card matrix-bot-interaction-card grid min-w-0 gap-3 rounded-xl border p-4" data-interaction-kind={interaction.kind}>
    <div><h3 className="break-words text-sm font-semibold">{title}</h3>
    {!actionable ? <p role="status" className="mt-1 text-xs" style={chatAgentMutedStyle}>{resolved ? "Resolved" : !actionsAvailable && card.state === "actionable" ? "Status unavailable. Refresh to respond." : card.state === "unavailable" ? "Only the designated person can respond." : card.state}</p> : null}</div>
    {access ? <div className="grid gap-1 text-xs" style={chatAgentMutedStyle}>
      <p>Requested access: {access.summary}</p>{access.boundary ? <p>{access.boundary}</p> : null}
    </div> : null}
    {!actionsAvailable && card.state === "actionable" && payload?.kind === "question"
      ? payload.questions.map((question) => <p key={question.questionId} className="text-sm">{question.question}</p>) : null}
    {actionable && payload?.kind === "question" ? <>
      {payload.questions.map((question) => <fieldset key={question.questionId} className="grid gap-2">
        <legend className="text-sm font-medium">{question.question}</legend>
        {question.options?.map((option) => <label key={option.label} className="flex items-start gap-2 text-sm">
          <input type={question.multiSelect ? "checkbox" : "radio"} name={`${interaction.interactionId}:${question.questionId}`}
            aria-label={option.label} checked={!question.multiSelect && Boolean(typedAnswers[question.questionId]?.trim())
              ? false : selectedAnswers[question.questionId]?.includes(option.label) ?? false}
            disabled={pending} onChange={() => {
              setSelectedAnswers((current) => {
                const values = current[question.questionId] ?? [];
                const next = question.multiSelect
                  ? values.includes(option.label) ? values.filter((value) => value !== option.label)
                    : values.length < 10 ? [...values, option.label] : values
                  : [option.label];
                return { ...current, [question.questionId]: next };
              });
              if (!question.multiSelect) setTypedAnswers((current) => ({ ...current, [question.questionId]: "" }));
            }} />
          <span>{option.label}<span className="block text-xs" style={chatAgentMutedStyle}>{option.description}</span></span>
        </label>)}
        {(!question.options || question.allowOther) ? <label className="grid gap-1 text-xs">
          {question.options ? "Other answer" : "Answer"}
          {question.secret ? <input type="password" aria-label={`Answer ${question.header}`}
            value={typedAnswers[question.questionId] ?? ""} maxLength={400} disabled={pending}
            onChange={(event) => typeAnswer(question.questionId, event.currentTarget.value)}
            className="w-full rounded-lg border bg-transparent p-2 text-sm" />
            : <textarea aria-label={`Answer ${question.header}`} value={typedAnswers[question.questionId] ?? ""}
              maxLength={400} disabled={pending} onChange={(event) => typeAnswer(question.questionId, event.currentTarget.value)}
              className="min-h-20 w-full rounded-lg border bg-transparent p-2 text-sm" />}
        </label> : null}
      </fieldset>)}
      {answerTooLong ? <p role="status" className="text-xs">Shorten an answer to fit the request.</p> : null}
      <button type="button" className={`${chatAgentButtonClass} justify-self-start`} disabled={pending || !allQuestionsAnswered}
        onClick={() => { void decide({ kind: "question", baseRevision: interaction.revision, structuredAnswers: questionAnswers }); }}>Answer</button>
    </> : null}
    {actionable && payload?.kind === "account_choice" ? <div className="flex flex-wrap gap-2">
      {payload.options.map((option) => <button key={option.connectionId} type="button" className={chatAgentButtonClass} disabled={pending}
        onClick={() => { void decide({ kind: "account_choice", baseRevision: interaction.revision, connectionId: option.connectionId }); }}>{option.label}</button>)}
    </div> : null}
    {actionable && payload?.kind === "connect_request" ? <>
      <p className="text-sm">{payload.benefit}</p>
      <div className="flex flex-wrap gap-2">{(["start", "decline"] as const).map((action) => <button key={action} type="button"
        className={chatAgentButtonClass} disabled={pending} onClick={() => { void decide({ kind: "connect_request", baseRevision: interaction.revision, action }); }}>
        {action === "start" ? "Connect" : "Decline"}</button>)}</div>
    </> : null}
    {routine && payload?.kind === "approval" ? <RoutineApprovalDetails approval={routine} agentName={agentName} preview={payload.preview}/> : null}
    {actionable && payload?.kind === "approval" ? <>
      {!routine ? <><p className="whitespace-pre-wrap text-sm leading-6">{payload.preview}</p>
      <details className="text-xs"><summary className="cursor-pointer font-medium">Approval details</summary><dl className="mt-2 grid gap-2">
        {payload.account ? <div><dt style={chatAgentMutedStyle}>Account</dt><dd>{payload.account.label} · {payload.account.service.replaceAll("_", " ")}</dd></div> : null}
        <div><dt style={chatAgentMutedStyle}>Action</dt><dd>{payload.tool.replaceAll("_", " ")}</dd></div>
        <div><dt style={chatAgentMutedStyle}>Permission</dt><dd>This action only</dd></div>
      </dl></details></> : null}
      <div className="flex flex-wrap gap-2">{(["approve", "deny"] as const).map((decision) => <button key={decision} type="button"
        className={chatAgentButtonClass} disabled={pending} onClick={() => { void decide({ kind: "approval", baseRevision: interaction.revision, decision }); }}>
        {routine ? decision === "approve" ? routine.source.routineId ? "Approve changes" : "Approve schedule" : "Cancel" : decision === "approve" ? "Approve" : "Deny"}</button>)}</div>
    </> : null}
    {isRoutine && !routine ? <p role="alert" className="text-sm">Schedule details are unavailable. Ask the Bot for a new proposal.</p> : null}
    {error ? <p role="alert" className="text-xs">{error}</p> : null}
    {connectUrl ? <a className={chatAgentButtonClass} href={connectUrl} rel="noopener noreferrer">Continue connecting</a> : null}
  </section>;
}
