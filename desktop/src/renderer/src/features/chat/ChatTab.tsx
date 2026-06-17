import { GitBranch, Laptop, Plus, SquareTerminal } from "lucide-react";
import { useState } from "react";
import { groupMessages } from "../../lib/chat";
import { useBoard } from "../../stores/board";
import { useHermesChat, type HermesStatus } from "../../stores/hermes-chat";
import { Conversation, ConversationContent } from "./elements/conversation";
import { Message, MessageContent, MessageResponse } from "./elements/message";
import { PromptInput } from "./elements/prompt-input";
import { Reasoning } from "./elements/reasoning";
import { Tool } from "./elements/tool";

function Pill({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <button
      type="button"
      className="flex items-center gap-1.5 rounded-md px-2 py-1 text-sm transition-colors hover:bg-[var(--bg-hover)]"
      style={{ color: "var(--text-secondary)" }}
    >
      {icon}
      {label}
    </button>
  );
}

function ConnectCard({ title, body, done }: { title: string; body: string; done?: boolean }) {
  return (
    <div
      className="flex flex-col gap-1.5 rounded-xl border p-4 text-left"
      style={{ background: "var(--bg-surface)", borderColor: "var(--border-subtle)", opacity: done ? 0.55 : 1 }}
    >
      <div className="flex items-center justify-between">
        <div className="h-6 w-6 rounded" style={{ background: "var(--bg-sunken)" }} />
        {done ? <span className="text-xs" style={{ color: "var(--success)" }}>✓</span> : null}
      </div>
      <span className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>{title}</span>
      <span className="text-xs leading-relaxed" style={{ color: "var(--text-secondary)" }}>{body}</span>
    </div>
  );
}

export function canSubmitChatDraft(draft: string, status: HermesStatus): boolean {
  return draft.trim().length > 0 && status === "idle";
}

export default function ChatTab() {
  const messages = useHermesChat((s) => s.messages);
  const status = useHermesChat((s) => s.status);
  const send = useHermesChat((s) => s.send);
  const abort = useHermesChat((s) => s.abort);
  const projects = useBoard((s) => s.projects);
  const [draft, setDraft] = useState("");

  const projectName = projects[0]?.name ?? projects[0]?.slug ?? "Matrix OS";
  const groups = groupMessages(messages);
  const empty = messages.length === 0;
  const lastMessage = messages.at(-1);
  const scrollKey = lastMessage ? `${lastMessage.id}:${lastMessage.content.length}:${status}` : status;

  const submit = () => {
    if (!canSubmitChatDraft(draft, status)) return;
    send(draft);
    setDraft("");
  };

  const composerFooter = (
    <>
      <Pill icon={<SquareTerminal size={13} />} label={projectName} />
      <Pill icon={<Laptop size={13} />} label="On VPS" />
      <Pill icon={<GitBranch size={13} />} label="main" />
    </>
  );

  if (empty) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="mx-auto flex w-full max-w-[760px] flex-1 flex-col justify-center px-5">
          <h1 className="mb-8 text-center text-2xl font-semibold tracking-tight" style={{ color: "var(--text-primary)", fontSize: "var(--text-2xl)" }}>
            What should we build in {projectName}?
          </h1>
          <PromptInput
            value={draft}
            onChange={setDraft}
            onSubmit={submit}
            onAbort={abort}
            busy={status !== "idle"}
            autoFocus
            footer={composerFooter}
          />
          <div className="mt-6 grid grid-cols-1 gap-3 md:grid-cols-3">
            <ConnectCard title="Connect messaging" body="Get context from recent team discussions" />
            <ConnectCard title="Connect email" body="Summarize stakeholder asks from email" />
            <ConnectCard title="Connect files" body="Review results, research, and plans" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Conversation scrollKey={scrollKey}>
        <ConversationContent>
          {groups.map((group) =>
            group.type === "tool_group" ? (
              <div key={group.messages[0]?.id ?? "tools"} className="flex flex-col gap-1.5">
                {group.messages.map((m) => (
                  <Tool key={m.id} name={m.content} detail={m.toolInput ? JSON.stringify(m.toolInput, null, 2) : undefined} />
                ))}
              </div>
            ) : group.message.role === "user" ? (
              <Message key={group.message.id} from="user">
                <MessageContent from="user">{group.message.content}</MessageContent>
              </Message>
            ) : (
              <Message key={group.message.id} from="assistant">
                <MessageContent from="assistant">
                  <MessageResponse>{group.message.content}</MessageResponse>
                </MessageContent>
              </Message>
            ),
          )}
          {status === "thinking" ? (
            <Reasoning streaming>
              <span className="status-pulse">Working on it…</span>
            </Reasoning>
          ) : null}
        </ConversationContent>
      </Conversation>
      <div className="mx-auto w-full max-w-[760px] px-5 pb-5">
        <PromptInput
          value={draft}
          onChange={setDraft}
          onSubmit={submit}
          onAbort={abort}
          busy={status !== "idle"}
          placeholder="Reply to Hermes…"
          footer={composerFooter}
        />
      </div>
    </div>
  );
}
