import type { CanonicalChatDetailResponse } from "@matrix-os/contracts";
import { Button } from "../Button.js";
import type { SetupQuestion } from "./creation-conversation.js";

export function AgentSetupTranscript({ detail, questions, openingMessageId, question, questionText, onAnswer, disabled, reviewing }: {
  detail: CanonicalChatDetailResponse | null;
  questions: SetupQuestion[];
  openingMessageId?: string;
  question: SetupQuestion | null;
  questionText?: string;
  reviewing: boolean;
  onAnswer(value: string): void;
  disabled: boolean;
}) {
  const latestAssistant = !questionText && !reviewing ? detail?.messages.findLast(message =>
    message.chatId === detail.record.chat.id
    && message.role === "assistant"
    && !questions.some(item => item.runId === message.runId)) : undefined;
  const latestAnswer = detail?.messages.findLast(message =>
    message.chatId === detail.record.chat.id && message.role === "user" && message.id !== openingMessageId);
  const answer = latestAnswer?.parts.flatMap(part => part.type === "text" ? [part.text] : []).join("").trim();
  const prompt = questionText ?? latestAssistant?.parts.flatMap(part => part.type === "text" ? [part.text] : []).join("").trim();
  if (!answer && !prompt) return null;

  return <div className="grid min-w-0 gap-3 text-sm leading-relaxed">
    {answer ? <p className="max-w-[85%] justify-self-end whitespace-pre-wrap rounded-xl bg-[var(--bg-hover,var(--secondary))] px-3 py-2 [overflow-wrap:anywhere]">{answer}</p> : null}
    {prompt ? <p aria-live="polite" className="whitespace-pre-wrap [overflow-wrap:anywhere]">{prompt}</p> : null}
    {question ? <div role="group" aria-label="Suggested replies" className="flex flex-wrap gap-2">
      {question.suggestedReplies.map(reply => <Button key={reply} variant="secondary" size="sm"
        className="min-h-8 max-w-full whitespace-normal text-left focus-visible:outline-2! focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]!"
        disabled={disabled} onClick={() => onAnswer(reply)}>{reply}</Button>)}
    </div> : null}
  </div>;
}
