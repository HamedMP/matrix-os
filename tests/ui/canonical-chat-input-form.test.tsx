// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CanonicalChatInputForm } from "../../packages/ui/src/chat/CanonicalChatInputForm";

const request = { id: "evt_question", runId: "run_question", requestId: "request_question", title: "A few questions",
  pending: true, submitted: false, resolved: false, timestamp: 0, questions: [{ questionId: "destination", header: "Destination", question: "Where should it go?",
    allowOther: true, secret: false, options: [{ label: "Inbox", description: "Keep it here" }, { label: "Archive", description: "Store it" }] }] };
afterEach(cleanup);
it("requires an explicit choice and submits its question identity", async () => {
  const submit = vi.fn().mockResolvedValue(true);
  render(<CanonicalChatInputForm request={request} onSubmit={submit} />);
  expect((screen.getByRole("button", { name: "Submit answer" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("radio", { name: /Inbox/ }));
  fireEvent.click(screen.getByRole("button", { name: "Submit answer" }));
  await waitFor(() => expect(submit).toHaveBeenCalledWith({ structuredAnswers: { destination: ["Inbox"] } }));
});
it("preserves typed answers after submission failure and never echoes raw errors", async () => {
  const submit = vi.fn().mockRejectedValue(new Error("/private/provider/token"));
  render(<CanonicalChatInputForm request={request} onSubmit={submit} />);
  fireEvent.click(screen.getByRole("radio", { name: "Other" }));
  fireEvent.change(screen.getByRole("textbox", { name: /Your answer/ }), { target: { value: "Team folder" } });
  fireEvent.click(screen.getByRole("button", { name: "Submit answer" }));
  await screen.findByRole("alert");
  expect((screen.getByRole("textbox", { name: /Your answer/ }) as HTMLInputElement).value).toBe("Team folder");
  expect(screen.queryByText(/private/)).toBeNull();
});
it("supports multiple questions and multi-select without losing free text", async () => {
  const submit = vi.fn().mockResolvedValue(true);
  render(<CanonicalChatInputForm request={{ ...request, questions: [
    { ...request.questions[0]!, multiSelect: true },
    { questionId: "note", header: "Note", question: "What should I include?", allowOther: false, secret: false },
  ] }} onSubmit={submit} />);
  fireEvent.click(screen.getByRole("checkbox", { name: /Inbox/ }));
  fireEvent.click(screen.getByRole("checkbox", { name: /Archive/ }));
  fireEvent.change(screen.getByRole("textbox", { name: "What should I include?" }), { target: { value: "The latest summary" } });
  fireEvent.click(screen.getByRole("button", { name: "Submit answer" }));
  await waitFor(() => expect(submit).toHaveBeenCalledWith({ structuredAnswers: { destination: ["Inbox", "Archive"], note: ["The latest summary"] } }));
});
it("does not offer controls for resolved or title-only requests", () => {
  const { rerender } = render(<CanonicalChatInputForm request={{ ...request, pending: false }} onSubmit={vi.fn()} />);
  expect(screen.queryByRole("button")).toBeNull();
  rerender(<CanonicalChatInputForm request={{ ...request, questions: undefined }} onSubmit={vi.fn()} />);
  expect(screen.queryByRole("button")).toBeNull();
  expect(screen.getByText(/unavailable/i)).toBeTruthy();
});

it("handles question IDs that match object prototype properties", async () => {
  const submit = vi.fn().mockResolvedValue(true);
  render(<CanonicalChatInputForm request={{ ...request, questions: [{ ...request.questions[0]!, questionId: "constructor" }] }} onSubmit={submit} />);
  fireEvent.click(screen.getByRole("radio", { name: /Inbox/ }));
  fireEvent.click(screen.getByRole("button", { name: "Submit answer" }));
  await waitFor(() => expect(submit).toHaveBeenCalledWith({ structuredAnswers: { constructor: ["Inbox"] } }));
});
