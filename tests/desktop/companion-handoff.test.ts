import { beforeEach, describe, expect, it } from "vitest";
import { openCompanionPrompt } from "../../desktop/src/renderer/src/features/companion/companion-handoff";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";
import { useHermesChat } from "../../desktop/src/renderer/src/stores/hermes-chat";
import { useTabs } from "../../desktop/src/renderer/src/stores/tabs";

describe("rabbit companion prompt handoff", () => {
  beforeEach(() => {
    useConnection.setState({ status: "signed-in" });
    useHermesChat.setState({
      status: "idle",
      messages: [],
      view: "index",
      activeRequestId: null,
      sessionId: null,
    });
    useTabs.setState({ tabs: [], activeTabId: null });
  });

  it("opens Hermes and sends the prompt through the canonical chat store", () => {
    expect(openCompanionPrompt("Plan my morning")).toBe(true);

    expect(useTabs.getState().tabs.at(-1)).toMatchObject({ kind: "chat", title: "Hermes" });
    expect(useHermesChat.getState().view).toBe("conversation");
    expect(useHermesChat.getState().messages[0]).toMatchObject({
      role: "user",
      content: "Plan my morning",
    });
  });

  it("does not accept prompts before authentication or while Hermes is busy", () => {
    useConnection.setState({ status: "signed-out" });
    expect(openCompanionPrompt("Private request")).toBe(false);

    useConnection.setState({ status: "signed-in" });
    useHermesChat.setState({ status: "thinking" });
    expect(openCompanionPrompt("Second request")).toBe(false);
    expect(useHermesChat.getState().messages).toEqual([]);
  });
});
