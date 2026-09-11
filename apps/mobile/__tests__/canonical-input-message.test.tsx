import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { CanonicalInputMessage } from "@/components/CanonicalInputMessage";

jest.mock("@clerk/clerk-expo", () => ({ useAuth: () => ({ getToken: async () => "test-token" }) }));
jest.mock("micromark", () => ({ micromark: jest.fn() }));
jest.mock("micromark-extension-gfm", () => ({ gfm: jest.fn(), gfmHtml: jest.fn() }));
const request = { id: "evt_input", runId: "run_test", requestId: "input_test", title: "Choose direction", pending: true, submitted: false, resolved: false, timestamp: 0,
  questions: [{ questionId: "direction", header: "Direction", allowOther: false, secret: false, question: "Which direction?", options: [{ label: "North", description: "Go north" }] }] };
const props = { chatId: "chat_test", gatewayUrl: "https://app.matrix-os.com/vm/test", onSettled: jest.fn() };
afterEach(() => jest.restoreAllMocks());
it("submits a choice to the original request and retries with the same id after failure", async () => {
  const fetchMock = jest.spyOn(global, "fetch").mockRejectedValueOnce(new Error("private upstream"))
    .mockResolvedValue({ ok: true, json: async () => ({ requestId: "input_test", submission: "accepted" }) } as Response);
  render(<CanonicalInputMessage {...props} request={request} />);
  fireEvent.press(screen.getByText("North"));
  fireEvent.press(screen.getByText("Submit answer"));
  await waitFor(() => expect(screen.getByText("The answer could not be submitted. Try again.")).toBeTruthy());
  expect(screen.queryByText("private upstream")).toBeNull();
  fireEvent.press(screen.getByText("Submit answer"));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  expect(fetchMock.mock.calls[0]![0]).toContain("/api/chats/chat_test/runs/run_test/inputs/input_test");
  expect(fetchMock.mock.calls[0]![1]!.body).toBe(fetchMock.mock.calls[1]![1]!.body);
  expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string).structuredAnswers).toEqual({ direction: ["North"] });
});
it("keeps settled requests read-only", () => {
  render(<CanonicalInputMessage {...props} request={{ ...request, pending: false }} />);
  expect(screen.queryByText("Submit answer")).toBeNull();
});
it("submits multiple choices together with an optional custom answer", async () => {
  const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue({ ok: true, json: async () => ({ requestId: "input_test", submission: "accepted" }) } as Response);
  render(<CanonicalInputMessage {...props} request={{ ...request, questions: [{ ...request.questions[0]!, multiSelect: true, allowOther: true }] }} />);
  fireEvent.press(screen.getByText("North"));
  fireEvent.press(screen.getByText("Other"));
  fireEvent.changeText(screen.getByLabelText("Your answer: Which direction?"), "East");
  fireEvent.press(screen.getByText("Submit answer"));
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string).structuredAnswers).toEqual({ direction: ["North", "East"] });
});
it("does not offer free text when the question disallows Other", () => {
  render(<CanonicalInputMessage {...props} request={request} />);
  expect(screen.queryByLabelText("Your answer: Which direction?")).toBeNull();
});
it("masks secret free text and closes expired questions", () => {
  const { rerender } = render(<CanonicalInputMessage {...props} request={{ ...request, questions: [{ ...request.questions[0]!, options: undefined, secret: true }] }} />);
  expect(screen.getByLabelText("Your answer: Which direction?").props.secureTextEntry).toBe(true);
  rerender(<CanonicalInputMessage {...props} request={{ ...request, expiresAt: "2000-01-01T00:00:00.000Z" }} />);
  expect(screen.queryByText("Submit answer")).toBeNull();
  expect(screen.getByText("This question has expired.")).toBeTruthy();
});

it.each(["constructor", "toString", "__proto__"])("handles question ID %s without inherited state", questionId => {
  render(<CanonicalInputMessage {...props} request={{ ...request, questions: [{ ...request.questions[0]!, questionId, options: undefined }] }} />);
  const field = screen.getByLabelText("Your answer: Which direction?");
  expect(field.props.value).toBe("");
  fireEvent.changeText(field, "North");
  expect(field.props.value).toBe("North");
});

it("reuses the request identity when a local answer changes after unknown delivery", async () => {
  const fetchMock = jest.spyOn(global, "fetch").mockRejectedValueOnce(new Error("Connection lost"))
    .mockResolvedValue({ ok: true, json: async () => ({ requestId: "input_test", submission: "already_submitted" }) } as Response);
  render(<CanonicalInputMessage {...props} request={{ ...request, questions: [{ ...request.questions[0]!, options: undefined }] }} />);
  fireEvent.changeText(screen.getByLabelText("Your answer: Which direction?"), "North");
  fireEvent.press(screen.getByText("Submit answer"));
  await waitFor(() => expect(screen.getByText("The answer could not be submitted. Try again.")).toBeTruthy());
  fireEvent.changeText(screen.getByLabelText("Your answer: Which direction?"), "South");
  fireEvent.press(screen.getByText("Submit answer"));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  const first = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
  const second = JSON.parse(fetchMock.mock.calls[1]![1]!.body as string);
  expect(second.clientRequestId).toBe(first.clientRequestId);
  expect(second.structuredAnswers).toEqual({ direction: ["South"] });
});
