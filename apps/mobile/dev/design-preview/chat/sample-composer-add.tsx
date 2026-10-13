import { useState } from "react";

import type { ComposerProps } from "@/components/chat/Composer";
import { ComposerAddControl } from "@/components/chat/ComposerAddControl";
import {
  MAX_MESSAGE_ATTACHMENTS,
  appendAttachments,
  type ChatAttachmentKind,
  type ComposerAttachment,
} from "@/lib/chat-attachments";
import { draftWithInvocation, type ChatSlashEntry } from "@/lib/chat-slash-entries";

const SAMPLE_KINDS: readonly ChatAttachmentKind[] = ["image", "file"];

const SAMPLE_SKILLS: readonly ChatSlashEntry[] = [
  {
    id: "skill:app-builder",
    kind: "skill",
    name: "App builder",
    description: "Plans and builds a small app from a description",
    invocation: "/app-builder",
  },
  {
    id: "skill:weekly-review",
    kind: "skill",
    name: "Weekly review",
    description: "Summarizes what changed this week and what is still open",
    invocation: "/weekly-review",
  },
  {
    id: "command:review",
    kind: "command",
    name: "Review",
    description: "Reviews the changes made in this chat",
    invocation: "/review",
  },
];

/**
 * The "+" of a frame's composer, working on the frame's own draft. What it
 * attaches stays on the phone: a frame sends nothing.
 */
export function useSampleComposerAdd(draft: string, setDraft: (text: string) => void) {
  const [attachments, setAttachments] = useState<readonly ComposerAttachment[]>([]);
  const composerAdd: Pick<ComposerProps, "attachments" | "onRemoveAttachment" | "addControl"> = {
    attachments,
    onRemoveAttachment: (id) => setAttachments((current) => current.filter((attachment) => attachment.id !== id)),
    addControl: (
      <ComposerAddControl
        kinds={SAMPLE_KINDS}
        room={MAX_MESSAGE_ATTACHMENTS - attachments.length}
        skills={SAMPLE_SKILLS}
        onAdd={(added) => setAttachments((current) => appendAttachments(current, added))}
        onInvoke={(invocation) => {
          setDraft(draftWithInvocation(draft, invocation, SAMPLE_SKILLS.map((entry) => entry.invocation)));
        }}
      />
    ),
  };
  return { attachments, clearAttachments: () => setAttachments([]), composerAdd };
}
