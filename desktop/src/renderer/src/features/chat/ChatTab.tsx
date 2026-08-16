import { FileText, Paperclip, PanelRight } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { BrandLogo } from "../../design/BrandPanel";
import { groupMessages } from "../../lib/chat";
import { useConnection } from "../../stores/connection";
import { useHermesChat, type HermesStatus } from "../../stores/hermes-chat";
import { AttachmentPreviewRow } from "./attachments/AttachmentPreviewRow";
import { appendHermesAttachmentPaths } from "./attachments/local-attachment-controller";
import { useConversationAttachments } from "./attachments/use-conversation-attachments";
import { Bubble, BubbleContent } from "./elements/bubble";
import { Conversation, ConversationContent, ConversationItem } from "./elements/conversation";
import { Message, MessageContent, MessageResponse } from "./elements/message";
import { PromptInput } from "./elements/prompt-input";
import { Reasoning } from "./elements/reasoning";
import { Tool } from "./elements/tool";
import { ChatResourcesPanel, conversationMessageDisplay } from "./ChatResourcesPanel";
import { HermesConversationIndex } from "./HermesConversationIndex";

export function canSubmitChatDraft(draft: string, status: HermesStatus, attachmentCount = 0): boolean {
  return (draft.trim().length > 0 || attachmentCount > 0) && status === "idle";
}

function HermesPane() {
  const messages = useHermesChat((state) => state.messages);
  const sessionId = useHermesChat((state) => state.sessionId);
  const status = useHermesChat((state) => state.status);
  const loadError = useHermesChat((state) => state.loadError);
  const send = useHermesChat((state) => state.send);
  const abort = useHermesChat((state) => state.abort);
  const [draft, setDraft] = useState("");
  const [uploadingAttachments, setUploadingAttachments] = useState(false);
  const [resourcesOpen, setResourcesOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const resourcesTriggerRef = useRef<HTMLButtonElement>(null);
  const attachments = useConversationAttachments(sessionId);

  const groups = groupMessages(messages);
  const empty = messages.length === 0;

  const closeResources = useCallback((restoreFocus = true) => {
    setResourcesOpen(false);
    if (restoreFocus) {
      window.requestAnimationFrame(() => resourcesTriggerRef.current?.focus());
    }
  }, []);

  const submit = async () => {
    if (uploadingAttachments || !canSubmitChatDraft(draft, status, attachments.items.length)) return;
    setUploadingAttachments(true);
    try {
      const uploaded = await attachments.uploadAll();
      if (!uploaded.ok) return;
      send(appendHermesAttachmentPaths(draft, uploaded.paths));
      setDraft("");
      attachments.clear();
    } finally {
      setUploadingAttachments(false);
    }
  };

  const attachmentPreviews = (
    <AttachmentPreviewRow
      items={attachments.items}
      disabled={uploadingAttachments}
      onRemove={attachments.remove}
      onRetry={(localId) => void attachments.retry(localId)}
    />
  );
  const composerReady = canSubmitChatDraft(draft, status, attachments.items.length);
  const composerControls = (
    <>
      <button
        type="button"
        aria-label="Attach files"
        className="flex h-8 w-8 items-center justify-center rounded-lg hover:bg-[var(--bg-hover)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
        style={{ color: "var(--text-secondary)" }}
        disabled={uploadingAttachments}
        onClick={() => fileInputRef.current?.click()}
      >
        <Paperclip size={16} aria-hidden />
      </button>
      <button
        ref={resourcesTriggerRef}
        type="button"
        aria-label="Resources"
        aria-expanded={resourcesOpen}
        className="flex h-8 items-center gap-1.5 rounded-lg px-2 text-sm hover:bg-[var(--bg-hover)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
        style={{ color: "var(--text-secondary)" }}
        onClick={() => setResourcesOpen((open) => !open)}
      >
        <PanelRight size={15} aria-hidden />
        <span className="hidden sm:inline">Resources</span>
      </button>
    </>
  );
  const harnessBadge = (
    <span
      className="rounded-full border px-2 py-1 text-xs font-medium"
      style={{ borderColor: "var(--border-default)", color: "var(--text-secondary)" }}
      title="Current chat harness"
    >
      Hermes
    </span>
  );
  const renderComposer = (placeholder: string, autoFocus = false) => (
    <>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        aria-label="Choose files"
        className="sr-only"
        onChange={(event) => {
          attachments.add(Array.from(event.currentTarget.files ?? []));
          event.currentTarget.value = "";
        }}
      />
      <PromptInput
        value={draft}
        onChange={setDraft}
        onSubmit={() => void submit()}
        onAbort={status !== "idle" ? abort : undefined}
        busy={status !== "idle" || uploadingAttachments}
        disabled={uploadingAttachments}
        canSubmit={composerReady}
        attachments={attachmentPreviews}
        autoFocus={autoFocus}
        placeholder={placeholder}
        ariaLabel={placeholder}
        controls={composerControls}
        trailingControls={harnessBadge}
      />
    </>
  );

  const loadErrorBanner = loadError ? (
    <div role="alert" className="mx-auto mt-3 w-[calc(100%-2.5rem)] max-w-[868px] rounded-lg border px-3 py-2 text-sm" style={{ borderColor: "var(--border-subtle)", color: "var(--text-secondary)" }}>
      {loadError}
    </div>
  ) : null;

  return (
    <div
      role="region"
      aria-label="Hermes conversation"
      className="relative flex min-h-0 flex-1 flex-col overflow-hidden"
      {...attachments.paneProps}
    >
      {loadErrorBanner}
      {empty ? (
        <div className="mx-auto flex min-h-0 w-full max-w-[868px] flex-1 flex-col px-5 pb-5">
          <div className="flex min-h-[180px] flex-1 flex-col items-center justify-center pb-8 text-center">
            <BrandLogo size={48} color="var(--text-primary)" className="mb-5" />
            <h1
              className="text-[32px] font-medium leading-tight tracking-[-0.02em] sm:text-[36px]"
              style={{ color: "var(--text-primary)", fontFamily: '"Instrument Serif", Georgia, serif' }}
            >
              How can I help you?
            </h1>
          </div>
          <div className="shrink-0">{renderComposer("How can I help you today?", true)}</div>
        </div>
      ) : (
        <>
          <Conversation>
            <ConversationContent className="justify-start pt-[clamp(72px,30vh,280px)]">
              {groups.map((group) =>
                group.type === "tool_group" ? (
                  <ConversationItem key={group.messages[0]?.id ?? "tools"} messageId={group.messages[0]?.id}>
                    <div className="flex flex-col gap-1.5">
                      {group.messages.map((message) => (
                        <Tool key={message.id} name={message.content} detail={message.toolInput ? JSON.stringify(message.toolInput, null, 2) : undefined} />
                      ))}
                    </div>
                  </ConversationItem>
                ) : group.message.role === "user" ? (
                  <ConversationItem key={group.message.id} messageId={`user:${group.message.id}`} scrollAnchor>
                    <Message align="end">
                      <MessageContent>
                        <Bubble variant="secondary" align="end">
                          {(() => {
                            const display = conversationMessageDisplay(group.message.content);
                            return (
                              <BubbleContent className="max-w-[580px] whitespace-pre-wrap" data-selectable>
                                {display.text}
                                {display.attachments.length > 0 ? (
                                  <span className="mt-2 flex flex-wrap justify-end gap-1.5">
                                    {display.attachments.map((name) => (
                                      <span
                                        key={name}
                                        className="inline-flex max-w-full items-center gap-1.5 rounded-md border px-2 py-1 text-xs"
                                        style={{ borderColor: "var(--border-default)", color: "var(--text-secondary)" }}
                                      >
                                        <FileText size={12} aria-hidden className="shrink-0" />
                                        <span className="truncate">{name}</span>
                                      </span>
                                    ))}
                                  </span>
                                ) : null}
                              </BubbleContent>
                            );
                          })()}
                        </Bubble>
                      </MessageContent>
                    </Message>
                  </ConversationItem>
                ) : (
                  <ConversationItem key={group.message.id} messageId={`assistant:${group.message.id}`}>
                    <Message>
                      <MessageContent>
                        <Bubble variant="ghost">
                          <BubbleContent className="max-w-[620px] overflow-visible">
                            <MessageResponse>{group.message.content}</MessageResponse>
                          </BubbleContent>
                        </Bubble>
                      </MessageContent>
                    </Message>
                  </ConversationItem>
                ),
              )}
              {status === "thinking" ? (
                <ConversationItem messageId="hermes:working">
                  <Reasoning streaming><span className="shimmer">Working on it…</span></Reasoning>
                </ConversationItem>
              ) : null}
            </ConversationContent>
          </Conversation>
          <div className="mx-auto w-full max-w-[868px] shrink-0 px-5 pb-5">
            {renderComposer("Reply to Hermes…")}
          </div>
        </>
      )}

      {resourcesOpen ? (
        <ChatResourcesPanel
          messages={messages}
          onClose={closeResources}
          onUpload={() => {
            fileInputRef.current?.click();
            closeResources(false);
          }}
        />
      ) : null}
    </div>
  );
}

export default function ChatTab() {
  const api = useConnection((state) => state.api);
  const conversationView = useHermesChat((state) => state.view);
  const indexStatus = useHermesChat((state) => state.indexStatus);
  const refreshConversations = useHermesChat((state) => state.refreshConversations);

  useEffect(() => {
    if (api && indexStatus === "idle") void refreshConversations(api);
  }, [api, indexStatus, refreshConversations]);

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      {conversationView === "index" ? <HermesConversationIndex api={api} /> : <HermesPane />}
    </div>
  );
}
