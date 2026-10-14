"use client";
import type { ChatMessage } from "@/lib/chat";
import { ChatAttachments } from "@matrix-os/ui";
import { Message, MessageContent } from "@/components/ai-elements/message";
import { Reasoning } from "@/components/ai-elements/reasoning";
import { extractThinking } from "@/components/ai-elements/reasoning-utils";
import { Plan } from "@/components/ai-elements/plan";
import { parsePlan } from "@/components/ai-elements/plan-utils";
import { Task } from "@/components/ai-elements/task";
import { parseTask } from "@/components/ai-elements/task-utils";
import { RichContent } from "@/components/ui-blocks";

export function AssistantBubble({
  content,
  attachments,
  openAttachment,
  loadImage,
  onAction,
}: {
  content: string;
  attachments?: ChatMessage["attachments"];
  openAttachment?: (path: string) => boolean | void;
  loadImage?: (src: string) => Promise<Blob>;
  onAction?: (text: string) => void;
}) {
  const { thinking, rest } = extractThinking(content);
  const planSteps = parsePlan(rest);
  const taskData = parseTask(rest);
  const displayContent = planSteps
    ? rest.replace(/```plan\n[\s\S]*?```/, "").trim()
    : taskData
      ? rest.replace(/```task\n[\s\S]*?```/, "").trim()
      : rest;

  return (
    <Message from="assistant">
      <MessageContent>
        {attachments?.length ? <ChatAttachments align="start" attachments={attachments} open={openAttachment} loadImage={loadImage} /> : null}
        {thinking && <Reasoning content={thinking} />}
        {planSteps && <Plan steps={planSteps} />}
        {taskData && <Task task={taskData} />}
        {displayContent && (
          <RichContent onAction={onAction} openFile={openAttachment}>{displayContent}</RichContent>
        )}
      </MessageContent>
    </Message>
  );
}
