// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CanonicalInputMessage } from "../../shell/src/components/chat/CanonicalInputMessage";

afterEach(cleanup);
it("keeps web connector consent visible and submits only an explicit choice", async () => {
  const request = { requestId: "req_connector", threadId: "thread_native", title: "Connector request", safeDescription: "Review", correlationId: "corr_connector", required: false,
    connectorActionId: "question_action", questions: [{ questionId: "question_action", header: "Permission", question: "Allow access?", allowOther: false, secret: false,
      options: ["Allow once", "Decline", "Cancel"].map((label) => ({ label, description: label })) }] };
  const message = { id: "input", role: "system" as const, content: "Request", timestamp: 1,
    metadata: { canonicalInput: { runId: "run_coding", request, pending: true } } };
  const submit = vi.fn(async () => false);
  const view = render(<CanonicalInputMessage message={message} onSubmit={submit} />);
  expect(submit).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
  await waitFor(() => expect(submit).toHaveBeenCalledWith("run_coding", "req_connector", { question_action: ["Allow once"] }));
  expect(await screen.findByRole("alert")).toBeTruthy();
  view.rerender(<CanonicalInputMessage message={{ ...message, metadata: { canonicalInput: { runId: "run_coding", request, pending: false } } }} onSubmit={submit} />);
  expect(screen.queryByRole("button", { name: "Allow once" })).toBeNull();
});
