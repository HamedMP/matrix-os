import { z } from "zod/v4";
import { CanonicalChatRunIdSchema, UserInputRequestSchema, type CanonicalSubmitChatInputRequest } from "@matrix-os/contracts";
import { StructuredInputForm } from "@matrix-os/ui";
import type { ChatMessage } from "@/lib/chat";

const Input = z.union([
  z.object({ runId: CanonicalChatRunIdSchema, request: UserInputRequestSchema, pending: z.boolean() }).strict(),
  z.object({ runId: CanonicalChatRunIdSchema, requestId: z.string().min(1).max(128), title: z.string().min(1).max(160), pending: z.boolean() }).strict(),
]);
export function canonicalInput(message: ChatMessage) {
  const parsed = Input.safeParse(message.metadata?.canonicalInput);
  return parsed.success ? parsed.data : null;
}

export function CanonicalInputMessage({ message, onSubmit, onStop }: {
  message: ChatMessage;
  onStop?: (runId: string) => void;
  onSubmit?: (runId: string, requestId: string, answers: CanonicalSubmitChatInputRequest["answers"]) => Promise<boolean>;
}) {
  const input = canonicalInput(message);
  if (!input) return null;
  if (!("request" in input) || !input.request.questions?.length) return <div className="rounded-md border p-3 text-sm">
    <p className="font-medium">{"request" in input ? input.request.title : input.title}</p>
    {input.pending ? <>
      <p>This request cannot be answered in this view. Stop the run, then retry with your clarification.</p>
      {onStop ? <button type="button" className="mt-2 rounded border px-3 py-1" onClick={() => onStop(input.runId)}>Stop run to retry</button> : null}
    </> : <p>Resolved</p>}
  </div>;
  return <div className="rounded-md border border-warning/30 bg-warning/5 p-3 text-sm">
    <p className="font-medium">{input.request.title}</p>
    {input.pending && onSubmit ? <StructuredInputForm key={input.request.requestId} request={input.request} submit={async (answers) => {
      if (!await onSubmit(input.runId, input.request.requestId, answers)) throw new Error("InputSubmissionFailed");
    }} /> : <p>{input.pending ? "Input unavailable" : "Resolved"}</p>}
  </div>;
}
