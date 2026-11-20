"use client";

import { useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowLeft01Icon, BubbleChatIcon, Cancel01Icon, CheckListIcon, Copy01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { POPOVER_LAYER } from "../layering.js";
import { ChatComposerSelect } from "../chat/composer/ChatComposerSelect.js";
import type { MessageBoardClient } from "./client.js";
import { BoardComposer } from "./BoardComposer.js";
import { validateChannelPath } from "./model.js";
import { fieldClass, iconButtonClass, primaryButtonClass, primaryButtonStyle, subtleBorder, textPrimary, textSecondary, textTertiary } from "./presentation.js";
import type { BoardActor, BoardMessage } from "./types.js";
import type { MutationResult } from "./use-message-board.js";

const NEW_CHANNEL = "__new__";
const ANY_PROFILE = "__any__";

export interface NewThreadFormProps {
  channels: readonly string[];
  defaultChannel: string;
  actors: readonly BoardActor[];
  viewerId: string;
  mutate(work: (client: MessageBoardClient, board: string) => Promise<unknown>): Promise<MutationResult>;
  onPosted(message: BoardMessage): void;
  onClose(): void;
  onBack?: () => void;
}

/** Starts a thread, optionally as a board task, in an existing or new channel. */
export function NewThreadForm({ channels, defaultChannel, actors, viewerId, mutate, onPosted, onClose, onBack }: NewThreadFormProps) {
  const [channel, setChannel] = useState(channels.includes(defaultChannel) ? defaultChannel : channels[0] ?? NEW_CHANNEL);
  const [newChannel, setNewChannel] = useState(channels.length === 0 ? defaultChannel : "");
  const [asTask, setAsTask] = useState(false);
  const [profile, setProfile] = useState(ANY_PROFILE);
  const path = channel === NEW_CHANNEL ? newChannel.trim() : channel;
  const pathValid = validateChannelPath(path);
  const profiles = [...new Set(actors.flatMap((actor) => (actor.profile ? [actor.profile] : [])))].sort();

  return <section aria-label="New thread" className="flex h-full min-h-0 flex-col"
    onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}>
    <header className="flex items-center gap-2 border-b px-3 pb-2 pt-2.5" style={subtleBorder}>
      {onBack ? <button type="button" aria-label="Back to threads" className={iconButtonClass} onClick={onBack}>
        <HugeiconsIcon icon={ArrowLeft01Icon} size={16} aria-hidden />
      </button> : null}
      <h2 className="flex-1 text-[15px] font-semibold" style={textPrimary}>New thread</h2>
      <button type="button" aria-label="Close new thread" className={iconButtonClass} onClick={onClose}>
        <HugeiconsIcon icon={Cancel01Icon} size={15} aria-hidden style={textTertiary} />
      </button>
    </header>
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 py-3">
      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        <span style={textSecondary}>Channel</span>
        {channels.length > 0 ? <ChatComposerSelect label="Post to channel" value={channel} menuSide="bottom" menuZIndex={POPOVER_LAYER} onChange={setChannel}
          options={[...channels.map((item) => ({ value: item, label: `#${item}` })), { value: NEW_CHANNEL, label: "New channel…" }]} /> : null}
        {channel === NEW_CHANNEL ? <input aria-label="New channel path" aria-invalid={newChannel.length > 0 && !pathValid} placeholder="team/topic"
          value={newChannel} maxLength={200} onChange={(event) => setNewChannel(event.currentTarget.value.toLowerCase())}
          className={`${fieldClass} h-8 w-44 font-mono`} style={{ ...subtleBorder, ...textPrimary }} /> : null}
        {channel === NEW_CHANNEL && newChannel.length > 0 && !pathValid
          ? <span role="alert" className="text-xs" style={{ color: "var(--danger-text)" }}>Lowercase letters, digits, - and _, joined by /</span> : null}
      </div>
      <BoardComposer label="Message" placeholder={asTask ? "What should the agent do? First line is the title." : "Write a message. First line is the title."}
        submitLabel={asTask ? "Create task" : "Post"} actors={actors} viewerId={viewerId} autoFocus onCancel={onClose}
        toolbar={<>
          <button type="button" aria-pressed={asTask} onClick={() => setAsTask((value) => !value)}
            className="inline-flex h-8 items-center gap-1.5 rounded-[10px] border px-2.5 text-[13px] outline-none hover:bg-[var(--bg-hover)] focus-visible:ring-2 focus-visible:ring-[var(--composer-focus,var(--primary,currentColor))] aria-pressed:border-[var(--composer-focus,var(--primary,currentColor))] aria-pressed:font-medium"
            style={{ ...subtleBorder, ...(asTask ? textPrimary : textSecondary) }}>
            <HugeiconsIcon icon={asTask ? Tick02Icon : CheckListIcon} size={14} aria-hidden /> Make this a task
          </button>
          {asTask && profiles.length > 0 ? <ChatComposerSelect label="Who may claim it" value={profile} menuSide="top" menuZIndex={POPOVER_LAYER} onChange={setProfile}
            options={[{ value: ANY_PROFILE, label: "Any agent" }, ...profiles.map((item) => ({ value: item, label: `Only ${item}` }))]} /> : null}
        </>}
        onSubmit={async (text) => {
          if (!pathValid) return { ok: false, error: "Choose a valid channel first." };
          const posted: { message: BoardMessage | null } = { message: null };
          const result = await mutate(async (client, board) => {
            posted.message = await client.post(board, { channel: path, text, ...(asTask ? { task: profile === ANY_PROFILE ? {} : { forProfile: profile } } : {}) });
          });
          if (result.ok && posted.message) onPosted(posted.message);
          return result;
        }} />
      {asTask ? <p className="text-xs" style={textTertiary}>Task text is instructions: an agent that claims it will act on it.</p> : null}
    </div>
  </section>;
}

export function EmptyBoard({ boardName, onPost }: { boardName: string; onPost(): void }) {
  const command = 'matrix board post dev "Login test is flaky"';
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
    } catch (error) {
      console.warn("[message-board] copy failed", error instanceof Error ? error.name : error);
    }
  };
  return <div data-testid="message-board-empty" className="flex h-full flex-col items-center justify-center gap-1.5 px-6 text-center">
    <span aria-hidden className="mb-1 grid size-10 place-items-center rounded-xl" style={{ background: "var(--bg-sunken, var(--muted))", ...textTertiary }}>
      <HugeiconsIcon icon={BubbleChatIcon} size={20} />
    </span>
    <p className="text-[15px] font-semibold" style={textPrimary}>Nothing posted yet</p>
    <p className="max-w-sm text-[13px]" style={textSecondary}>
      {boardName} is where agents and people share findings, ask questions and hand off tasks that any agent can claim.
    </p>
    <button type="button" className={`${primaryButtonClass} mt-2`} style={primaryButtonStyle} onClick={onPost}>Post a message</button>
    <div className="mt-3 flex max-w-full items-center gap-1 rounded-[10px] border py-1 pl-2.5 pr-1" style={subtleBorder}>
      <code className="truncate font-mono text-xs" style={textSecondary}>{command}</code>
      <button type="button" aria-label={copied ? "Command copied" : "Copy command"} className={iconButtonClass} onClick={() => void copy()}>
        <HugeiconsIcon icon={copied ? Tick02Icon : Copy01Icon} size={14} aria-hidden style={textTertiary} />
      </button>
    </div>
    <p className="text-[11.5px]" style={textTertiary}>Or post from any terminal or agent session.</p>
  </div>;
}
