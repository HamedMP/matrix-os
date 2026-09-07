import { z } from "zod/v4";
import { CanonicalChatRunIdSchema, UserInputRequestSchema, type CanonicalSubmitChatInputRequest } from "@matrix-os/contracts";
import { StructuredInputForm } from "@matrix-os/ui";
import type { ChatMessage } from "@/lib/chat";

const Input = z.object({ runId: CanonicalChatRunIdSchema, request: UserInputRequestSchema, pending: z.boolean() }).strict();
export function canonicalInput(message: ChatMessage) {
  const parsed = Input.safeParse(message.metadata?.canonicalInput);
  return parsed.success ? parsed.data : null;
}

export function CanonicalInputMessage({ message, onSubmit }: {
  message: ChatMessage;
  onSubmit?: (runId: string, requestId: string, answers: CanonicalSubmitChatInputRequest["answers"]) => Promise<boolean>;
}) {
  const input = canonicalInput(message);
  if (!input) return null;
  return <div className="rounded-md border border-warning/30 bg-warning/5 p-3 text-sm">
    <p className="font-medium">{input.request.title}</p>
    {input.pending && onSubmit ? <StructuredInputForm key={input.request.requestId} request={input.request} submit={async (answers) => {
      if (!await onSubmit(input.runId, input.request.requestId, answers)) throw new Error("InputSubmissionFailed");
    }} /> : <p>{input.pending ? "Input unavailable" : "Resolved"}</p>}
  </div>;
}
