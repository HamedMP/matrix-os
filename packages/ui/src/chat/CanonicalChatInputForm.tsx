import React, { useEffect, useId, useRef, useState } from "react";
import { buildCanonicalChatInputAnswer, type CanonicalChatInputView, type CanonicalSubmitChatInputRequest } from "@matrix-os/contracts";

function own<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

const borderStyle = { borderColor: "var(--border-default, var(--border))" };

type Answer = Omit<CanonicalSubmitChatInputRequest, "clientRequestId">;
export interface CanonicalChatInputFormProps {
  request: CanonicalChatInputView;
  onSubmit?: (answer: Answer) => Promise<boolean>;
}

/** Shared Web/Electron questions. Keyed by run/request so drafts cannot cross requests. */
export function CanonicalChatInputForm(props: CanonicalChatInputFormProps) {
  return <InputForm key={`${props.request.runId}\0${props.request.requestId}`} {...props} />;
}

function InputForm({ request, onSubmit }: CanonicalChatInputFormProps) {
  const id = useId();
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, boolean>>({});
  const [text, setText] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [failed, setFailed] = useState(false);
  const [expired, setExpired] = useState(() => Boolean(request.expiresAt && Date.parse(request.expiresAt) <= Date.now()));
  const busy = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!request.expiresAt) return;
    const remaining = Date.parse(request.expiresAt) - Date.now();
    if (remaining <= 0) { setExpired(true); return; }
    const timer = setTimeout(() => setExpired(true), Math.min(remaining, 2_147_483_647));
    return () => clearTimeout(timer);
  }, [request.expiresAt]);
  const questions = request.questions ?? [];
  const structuredAnswers = Object.fromEntries(questions.map(question => {
    const choices = own(selected, question.questionId) ?? [];
    const freeText = own(text, question.questionId)?.trim();
    const values = question.options?.length
      ? [...choices, ...(own(other, question.questionId) && freeText ? [freeText] : [])]
      : freeText ? [freeText] : [];
    return [question.questionId, values];
  }));
  const hasQuestion = questions.length > 0 || Boolean(request.safeDescription);
  const structuredAnswer = buildCanonicalChatInputAnswer(request, structuredAnswers);
  const complete = questions.length > 0
    ? structuredAnswer !== null && questions.every(q => !own(other, q.questionId) || Boolean(own(text, q.questionId)?.trim()))
    : Boolean(text.answer?.trim());
  const available = request.pending && !request.submitted && !submitted && !expired && hasQuestion && Boolean(onSubmit);
  const answer: Answer = questions.length > 0 ? structuredAnswer ?? {} : { answer: text.answer?.trim() ?? "" };
  const submit = async () => {
    if (!available || !complete || busy.current || !onSubmit) return;
    busy.current = true; setPending(true); setFailed(false);
    try {
      const ok = await onSubmit(answer);
      if (mounted.current) { setSubmitted(ok); setFailed(!ok); }
    } catch (error: unknown) {
      console.warn("[chat-input] Submission failed:", error instanceof Error ? error.name : "UnknownError");
      if (mounted.current) setFailed(true);
    } finally {
      busy.current = false;
      if (mounted.current) setPending(false);
    }
  };
  const closedLabel = request.reason === "expired" || expired ? "This question has expired."
    : request.reason === "cancelled" ? "Input cancelled"
    : request.resolved || submitted ? "Answer submitted"
    : request.submitted ? "Answer submitted; awaiting confirmation."
    : !hasQuestion ? "Answering is unavailable for this request. Stop the run and try again."
    : !request.pending ? "Input closed"
    : "Answering is unavailable for this request. Stop the run and try again.";
  return <section style={borderStyle} className="space-y-3 rounded-xl border p-3 text-sm" aria-label={request.title}>
    <p className="font-medium">{request.title}</p>
    {request.safeDescription ? <p className="opacity-75 whitespace-pre-wrap">{request.safeDescription}</p> : null}
    {available ? <form className="space-y-3" onSubmit={event => { event.preventDefault(); void submit(); }}>
      {questions.map(q => <fieldset key={q.questionId} disabled={pending} className="space-y-2">
        <legend className="font-medium whitespace-pre-wrap">{q.question}</legend>
        {q.options?.map(option => <label key={option.label} style={borderStyle} className="flex cursor-pointer items-start gap-2 rounded-md border p-2">
          <input type={q.multiSelect ? "checkbox" : "radio"} name={`${id}-${q.questionId}`}
            checked={(own(selected, q.questionId) ?? []).includes(option.label)}
            onChange={() => {
              setSelected(current => ({ ...current, [q.questionId]: q.multiSelect
                ? (own(current, q.questionId) ?? []).includes(option.label)
                  ? own(current, q.questionId)!.filter(value => value !== option.label)
                  : [...(own(current, q.questionId) ?? []), option.label]
                : [option.label] }));
              if (!q.multiSelect) setOther(current => ({ ...current, [q.questionId]: false }));
            }} />
          <span><span className="font-medium">{option.label}</span>{option.description ? <span className="block opacity-70">{option.description}</span> : null}</span>
        </label>)}
        {q.options?.length && q.allowOther ? <label className="flex items-center gap-2">
          <input type={q.multiSelect ? "checkbox" : "radio"} name={`${id}-${q.questionId}`} checked={own(other, q.questionId) ?? false}
            onChange={() => {
              setOther(current => ({ ...current, [q.questionId]: q.multiSelect ? !own(current, q.questionId) : true }));
              if (!q.multiSelect) setSelected(current => ({ ...current, [q.questionId]: [] }));
            }} />Other
        </label> : null}
        {!q.options?.length || own(other, q.questionId) ? <input
          type={q.secret ? "password" : "text"} autoComplete="off"
          aria-label={q.options?.length ? `Your answer: ${q.question}` : q.question}
          maxLength={400} value={own(text, q.questionId) ?? ""}
          style={borderStyle} className="w-full rounded-md border bg-transparent px-2 py-2"
          onChange={event => setText(current => ({ ...current, [q.questionId]: event.target.value }))} /> : null}
      </fieldset>)}
      {questions.length === 0 ? <textarea aria-label={request.safeDescription ?? request.title} maxLength={32000}
        disabled={pending} value={text.answer ?? ""} style={borderStyle} className="w-full rounded-md border bg-transparent p-2"
        onChange={event => setText({ answer: event.target.value })} /> : null}
      <button type="submit" style={borderStyle} disabled={pending || !complete} className="rounded-md border px-3 py-1.5 font-medium disabled:opacity-50">
        {pending ? "Submitting…" : "Submit answer"}
      </button>
      {failed ? <p role="alert">The answer could not be submitted. Try again.</p> : null}
    </form> : <p role="status" className="opacity-70">{closedLabel}</p>}
  </section>;
}
