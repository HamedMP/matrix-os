import { describe, expect, it, vi } from "vitest";
import { submitCanonicalInput } from "../../packages/gateway/src/chat/input-control.js";
const owner = { type: "personal" as const, ownerId: "owner_test" };
function fixture() {
  const request = { type: "input.requested", requestId: "input_test", questions: [{ questionId: "q", question: "Name?", header: "Name", allowOther: false, secret: false }] };
  let submitted: unknown;
  const repository = {
    getInputState: vi.fn(async () => ({ request, submitted, resolved: false })),
    getAdapterState: vi.fn(async () => null),
    appendRunActivities: vi.fn(async (_owner, _chatId, _runId, events) => { submitted = events[0]; return 1; }),
  };
  const submitInput = vi.fn(async () => { throw new Error("private upstream failure"); });
  const active = { owner, chatId: "chat_test", instanceId: "test", controller: new AbortController(), adapter: { driverKind: "codex", submitInput } };
  return { repository, active, submitInput, owner, chatId: "chat_test", runId: "run_test", requestId: "input_test", input: { clientRequestId: "req_test", structuredAnswers: { q: ["Ada"] } } };
}
describe("input delivery fencing", () => {
  it("never repeats an uncertain native delivery and does not persist the answer", async () => {
    const options = fixture();
    await expect(submitCanonicalInput(options as never)).rejects.toMatchObject({ status: 503, safeError: { retryable: false } });
    expect(JSON.stringify(options.repository.appendRunActivities.mock.calls)).not.toContain("Ada");
    await expect(submitCanonicalInput(options as never)).resolves.toMatchObject({ submission: "already_submitted" });
    expect(options.submitInput).toHaveBeenCalledTimes(1);
  });
  it("rejects cancellation before claiming or calling the native request", async () => {
    const options = fixture();
    options.active.controller.abort();
    await expect(submitCanonicalInput(options as never)).rejects.toMatchObject({ status: 409 });
    expect(options.repository.appendRunActivities).not.toHaveBeenCalled();
    expect(options.submitInput).not.toHaveBeenCalled();
  });
});

it("rejects oversized legacy free text without claiming or calling the provider", async () => {
  const options = fixture();
  await expect(submitCanonicalInput({ ...options, input: { clientRequestId: "req_large", answer: "a".repeat(401) } } as never)).rejects.toMatchObject({ status: 409 });
  expect(options.repository.appendRunActivities).not.toHaveBeenCalled();
  expect(options.submitInput).not.toHaveBeenCalled();
});
