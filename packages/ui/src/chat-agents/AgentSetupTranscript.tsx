import * as Collapsible from "@radix-ui/react-collapsible";
import type { CanonicalChatDetailResponse } from "@matrix-os/contracts";
import type { SetupQuestion } from "./creation-conversation.js";
import { chatAgentButtonClass } from "./theme.js";

export function AgentSetupTranscript({ detail, questions, openingMessageId, question, onAnswer, disabled, reviewing }: {
  detail: CanonicalChatDetailResponse | null; questions: SetupQuestion[]; openingMessageId?: string;
  question: SetupQuestion | null; reviewing: boolean; onAnswer(value: string): void; disabled: boolean;
}) {
  const rows = (detail?.messages ?? []).flatMap(message => {
    if (message.chatId !== detail?.record.chat.id || message.id === openingMessageId || (message.role !== "user" && message.role !== "assistant")) return [];
    // The structured question is the one that its reply buttons answer.
    if (message.role === "assistant" && questions.some(item => item.runId === message.runId)) return [];
    const body = message.parts.flatMap(part => part.type === "text" ? [part.text] : []).join("");
    return body.trim() ? [{ key: message.id, role: message.role, body, at: message.createdAt }] : [];
  });
  for (const item of questions) rows.push({ key: item.id, role: "assistant", body: item.question, at: item.occurredAt });
  rows.sort((a, b) => a.at.localeCompare(b.at));
  if (!rows.length) return null;
  const focused = question ? rows.find(row => row.key === question.id) : reviewing ? undefined : rows.at(-1);
  const history = rows.filter(row => row !== focused);
  return <div className="grid gap-2 text-sm leading-relaxed">
    {history.length ? <Collapsible.Root>
      <Collapsible.Trigger type="button" className="text-xs underline underline-offset-4">Earlier messages</Collapsible.Trigger>
      <Collapsible.Content><ol aria-label="Earlier setup messages" className="mt-2 grid gap-3">
        {history.map(row => <li key={row.key} className={row.role === "user"
          ? "max-w-[85%] justify-self-end whitespace-pre-wrap break-words rounded-xl bg-[var(--bg-hover,var(--secondary))] px-3 py-2"
          : "min-w-0 whitespace-pre-wrap break-words"}>{row.body}</li>)}
      </ol></Collapsible.Content>
    </Collapsible.Root> : null}
    {focused ? <p aria-live="polite" className="whitespace-pre-wrap break-words">{focused.body}</p> : null}
    {question ? <div role="group" aria-label="Suggested replies" className="flex flex-wrap gap-2">
      {question.suggestedReplies.map(reply => <button key={reply} type="button"
        className={`${chatAgentButtonClass} max-w-full whitespace-normal break-words text-left`}
        disabled={disabled} onClick={() => onAnswer(reply)}>{reply}</button>)}
    </div> : null}
  </div>;
}
