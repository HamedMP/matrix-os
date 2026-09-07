"use client";

import { useRef, useState } from "react";
import type { UserInputAnswerRequest, UserInputRequest } from "@matrix-os/contracts";

type Answers = NonNullable<UserInputAnswerRequest["structuredAnswers"]>;

/** Values stay in this form until an explicit submit; never copy them into transcript text. */
export function StructuredInputForm({ request, submit }: {
  request: UserInputRequest;
  submit(answers: Answers): Promise<void>;
}) {
  const [answers, setAnswers] = useState<Answers>({});
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const busy = useRef(false);
  const questions = request.questions ?? [];
  const action = questions.find((question) => question.questionId === request.connectorActionId);
  const fields = questions.filter((question) => question !== action);
  const ready = fields.every((question) => !(question.required ?? request.required)
    || answers[question.questionId]?.some((value) => value.trim()));
  const send = async (decision?: string) => {
    if (busy.current) return;
    const cancel = Boolean(action && decision !== "Allow once");
    if (!cancel && !ready) return;
    const values: Answers = cancel ? {} : Object.fromEntries(Object.entries(answers)
      .filter(([, values]) => values.length && values.some((value) => value.trim())));
    if (action && decision) values[action.questionId] = [decision];
    busy.current = true;
    setPending(true);
    setFailed(false);
    try { await submit(values); }
    catch (error: unknown) {
      console.warn("[conversation] input submission failed:", error instanceof Error ? error.name : "UnknownError");
      setFailed(true);
    } finally { busy.current = false; setPending(false); }
  };
  return (
    <div className="mt-2 grid gap-3 ph-no-capture" data-slot="structured-input-form">
      {request.connectorUrl ? (
        <a href={request.connectorUrl} target="_blank" rel="noopener noreferrer" className="underline">
          Open connector authorization ({new URL(request.connectorUrl).hostname})
        </a>
      ) : null}
      {fields.map((question) => (
        <fieldset key={question.questionId} disabled={pending} className="grid gap-1">
          <legend className="text-sm font-medium">{question.question}</legend>
          {question.options ? (
            <div className="grid gap-1">
              {question.options.map((option) => (
                <label key={option.label} className="flex items-start gap-2 text-sm">
                  <input type={question.multiple ? "checkbox" : "radio"}
                    name={`${request.requestId}:${question.questionId}`}
                    checked={answers[question.questionId]?.includes(option.label) ?? false}
                    onChange={(event) => setAnswers((current) => {
                      const selected = current[question.questionId] ?? [];
                      const next = question.multiple
                        ? event.target.checked ? [...selected, option.label].slice(0, 4) : selected.filter((value) => value !== option.label)
                        : [option.label];
                      return { ...current, [question.questionId]: next };
                    })} />
                  <span>{option.label}<span className="block text-xs opacity-70">{option.description}</span></span>
                </label>
              ))}
            </div>
          ) : null}
          {!question.options || question.allowOther ? (
            <input aria-label={question.question} type={question.secret ? "password" : "text"}
              autoComplete="off" maxLength={400}
              className="min-w-0 rounded border bg-transparent px-2 py-1 text-sm"
              value={answers[question.questionId]?.[0] ?? ""}
              onChange={(event) => setAnswers((current) => ({ ...current, [question.questionId]: [event.target.value] }))} />
          ) : null}
        </fieldset>
      ))}
      {action ? <p className="text-sm">{action.question}</p> : null}
      <div className="flex flex-wrap gap-2">
        {(action?.options?.map((option) => option.label) ?? ["Submit"]).map((label) => (
          <button key={label} type="button" disabled={pending || ((label === "Allow once" || !action) && !ready)}
            className="rounded border px-3 py-1 text-sm disabled:opacity-50"
            onClick={() => void send(action ? label : undefined)}>{pending ? "Sending…" : label}</button>
        ))}
      </div>
      {failed ? <p role="alert" className="text-sm">The response could not be submitted. Check your answers and try again.</p> : null}
    </div>
  );
}
