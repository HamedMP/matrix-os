// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StructuredInputForm } from "../../desktop/src/renderer/src/components/conversation/StructuredInputForm";
import type { UserInputRequest } from "@matrix-os/contracts";
afterEach(cleanup);
const request: UserInputRequest = {
  requestId: "req_form", threadId: "thread_form", title: "Connector request", safeDescription: "Review this request.", correlationId: "corr_form", required: false,
  connectorActionId: "question_action", questions: [
    { questionId: "question_name", header: "Name", question: "Enter a name", required: true, allowOther: false, secret: true },
    { questionId: "question_action", header: "Permission", question: "Allow this request?", allowOther: false, secret: false,
      options: ["Allow once", "Decline", "Cancel"].map((label) => ({ label, description: label })) },
  ],
};
describe("structured consent", () => {
  it("does not auto-submit and permits cancellation without required field values", async () => {
    const submit = vi.fn(async () => {});
    render(<StructuredInputForm request={request} submit={submit} />);
    expect(submit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(submit).toHaveBeenCalledWith({ question_action: ["Cancel"] }));
  });
  it("submits structured values with consent and retains them after failure", async () => {
    const submit = vi.fn(async () => { throw new Error("private failure"); });
    render(<StructuredInputForm request={request} submit={submit} />);
    fireEvent.change(screen.getByLabelText("Enter a name"), { target: { value: "Ada" } });
    fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
    await waitFor(() => expect(submit).toHaveBeenCalledWith({ question_name: ["Ada"], question_action: ["Allow once"] }));
    expect((await screen.findByRole("alert")).textContent).not.toContain("private failure");
    expect((screen.getByLabelText("Enter a name") as HTMLInputElement).value).toBe("Ada");
  });
});
