import { cleanup, fireEvent, render, screen } from "@testing-library/react-native";

import { StepsBlock } from "../components/chat/StepsBlock";
import type { TranscriptActivity, TranscriptMessage } from "../lib/canonical-chat-transcript";

import { flat } from "./ui-test-utils";

function steps(count: number, state: TranscriptActivity["state"] = "completed"): TranscriptActivity[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `step_${index + 1}`, kind: "tool", state, label: `Step ${index + 1}`,
  }));
}

function reply(overrides: Partial<TranscriptMessage> = {}): TranscriptMessage {
  return {
    id: "msg_reply", role: "assistant", text: "Done.", toolCalls: [], activities: [],
    isRunning: false, elapsedSeconds: 12, createdAt: 0, ...overrides,
  };
}

describe("StepsBlock", () => {
  afterEach(cleanup);

  it("is a card-filled block with its lines 8pt apart", () => {
    render(<StepsBlock message={reply({ activities: steps(3) })} />);

    expect(flat(screen.getByTestId("steps-block"))).toMatchObject({
      backgroundColor: "#FAF9F7",
      borderRadius: 14,
      paddingHorizontal: 14,
      paddingVertical: 12,
      gap: 8,
    });
    expect(screen.getByText("Step 1")).toBeTruthy();
    expect(screen.getByText("Step 3")).toBeTruthy();
  });

  it.each([1, 5])("always shows %i steps, with no toggle and no time label", (count) => {
    render(<StepsBlock message={reply({ activities: steps(count) })} />);

    expect(screen.getByTestId("steps-block")).toBeTruthy();
    expect(screen.getByText(`Step ${count}`)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Hide work" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Show work" })).toBeNull();
    expect(screen.queryByText("Worked 12s")).toBeNull();
  });

  it("folds more than five finished steps behind the time label", () => {
    render(<StepsBlock message={reply({ activities: steps(6) })} />);

    expect(screen.queryByTestId("steps-block")).toBeNull();
    const toggle = screen.getByRole("button", { name: "Show work" });
    expect(toggle.props.accessibilityState).toMatchObject({ expanded: false });
    expect(flat(screen.getByText("Worked 12s"))).toMatchObject({
      fontFamily: "Geist_400Regular",
      fontSize: 13,
      lineHeight: 18,
      color: "#635F5F",
    });

    fireEvent.press(toggle);

    expect(screen.getByTestId("steps-block")).toBeTruthy();
    expect(screen.getByText("Step 6")).toBeTruthy();
    fireEvent.press(screen.getByRole("button", { name: "Hide work" }));
    expect(screen.queryByTestId("steps-block")).toBeNull();
  });

  it("gives the toggle a 44pt target", () => {
    render(<StepsBlock message={reply({ activities: steps(6) })} />);

    expect(flat(screen.getByRole("button", { name: "Show work" })).minHeight).toBe(44);
  });

  it("keeps more than five steps open while the turn is running, until it is closed by hand", () => {
    render(<StepsBlock message={reply({ activities: steps(6, "running"), isRunning: true, elapsedSeconds: undefined })} />);

    expect(screen.getByText("Working…")).toBeTruthy();
    expect(screen.getByTestId("steps-block")).toBeTruthy();

    fireEvent.press(screen.getByRole("button", { name: "Hide work" }));

    expect(screen.queryByTestId("steps-block")).toBeNull();
  });

  it("lists a tool call once when the run's activity already covers it, and on its own line otherwise", () => {
    render(<StepsBlock message={reply({
      activities: steps(1),
      toolCalls: [{ id: "step_1", label: "Step 1 request" }, { id: "call_other", label: "Read the current app" }],
    })} />);

    expect(screen.getByText("Step 1")).toBeTruthy();
    expect(screen.queryByText("Step 1 request")).toBeNull();
    expect(screen.getByText("Read the current app")).toBeTruthy();
  });

  it("counts tool calls towards the five-step rule", () => {
    render(<StepsBlock message={reply({
      activities: steps(4),
      toolCalls: [{ id: "call_a", label: "Call A" }, { id: "call_b", label: "Call B" }],
    })} />);

    expect(screen.queryByTestId("steps-block")).toBeNull();
    expect(screen.getByRole("button", { name: "Show work" })).toBeTruthy();
  });

  it("draws nothing for a finished reply without steps", () => {
    render(<StepsBlock message={reply()} />);

    expect(screen.toJSON()).toBeNull();
  });

  it("shows a single running line while a turn has started but has nothing to show yet", () => {
    render(<StepsBlock message={reply({ text: "", isRunning: true, elapsedSeconds: undefined })} />);

    expect(screen.getByTestId("steps-block")).toBeTruthy();
    expect(flat(screen.getByText("Working…"))).toMatchObject({ fontFamily: "Geist_500Medium", color: "#242323" });
  });

  it("leaves the running line out once the reply has text", () => {
    render(<StepsBlock message={reply({ text: "Looking", isRunning: true, elapsedSeconds: undefined })} />);

    expect(screen.toJSON()).toBeNull();
  });
});
