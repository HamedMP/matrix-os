import { expect, it } from "vitest";
import { dispatchAdmissionKey, hasStoppingChatExecution } from "../../packages/gateway/src/chat/dispatch-ownership";

const owner = { type: "personal" as const, ownerId: "owner_execution" };

it("rechecks retained execution ownership after cancellation changes during admission", () => {
  const controller = new AbortController();
  const executions = [{ owner, chatId: "chat_execution", controller,
    admissionKey: dispatchAdmissionKey("turn", "req_original") }];
  expect(hasStoppingChatExecution(executions, owner, "chat_execution")).toBe(false);
  controller.abort();
  expect(hasStoppingChatExecution(executions, owner, "chat_execution")).toBe(true);
  expect(hasStoppingChatExecution([], owner, "chat_execution")).toBe(false);
});

it("allows an exact admitted request replay but never a new turn or retry through cleanup", () => {
  const controller = new AbortController();
  controller.abort();
  const original = dispatchAdmissionKey("turn", "req_original");
  const executions = [{ owner, chatId: "chat_execution", controller, admissionKey: original }];
  expect(hasStoppingChatExecution(executions, owner, "chat_execution", original)).toBe(false);
  for (const key of [dispatchAdmissionKey("turn", "req_new"), dispatchAdmissionKey("retry", "req_original", "turn_original")]) {
    expect(hasStoppingChatExecution(executions, owner, "chat_execution", key)).toBe(true);
  }
  // The last pre-dispatch check permits no new execution, including callers
  // that reused a request key but were not reported already-accepted by storage.
  expect(hasStoppingChatExecution(executions, owner, "chat_execution")).toBe(true);
});

it("scopes retry replay keys to their turn and retains unknown queued admission ownership", () => {
  const controller = new AbortController();
  controller.abort();
  const original = dispatchAdmissionKey("retry", "req_retry", "turn_original");
  expect(hasStoppingChatExecution([{ owner, chatId: "chat_execution", controller, admissionKey: original }],
    owner, "chat_execution", original)).toBe(false);
  expect(hasStoppingChatExecution([{ owner, chatId: "chat_execution", controller, admissionKey: original }],
    owner, "chat_execution", dispatchAdmissionKey("retry", "req_retry", "turn_other"))).toBe(true);
  expect(hasStoppingChatExecution([{ owner, chatId: "chat_execution", controller }],
    owner, "chat_execution", original)).toBe(true);
});

it("does not block an unrelated owner's or Chat's execution", () => {
  const controller = new AbortController();
  controller.abort();
  const executions = [{ owner, chatId: "chat_execution", controller }];
  expect(hasStoppingChatExecution(executions, owner, "chat_other")).toBe(false);
  expect(hasStoppingChatExecution(executions, { ...owner, ownerId: "owner_other" }, "chat_execution")).toBe(false);
});
