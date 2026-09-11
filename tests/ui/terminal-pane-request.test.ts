import { describe, expect, it, vi } from "vitest";
import {
  dispatchTerminalPaneRequest,
  TerminalPaneActionsUnavailableError,
} from "../../packages/ui/src/terminal/terminal-pane-request.js";

describe("pane endpoint compatibility", () => {
  const missing = new Error("missing route");
  const setup = () => ({
    post: vi
      .fn()
      .mockRejectedValueOnce(missing)
      .mockResolvedValue({ ok: true }),
    isMissingRoute: (error: unknown) => error === missing,
  });
  it("targets canonical workspace tabs without treating their ref as a legacy session name", async () => {
    const post = vi.fn().mockResolvedValue({ ok: true });
    await dispatchTerminalPaneRequest({
      post,
      isMissingRoute: () => false,
      sessionName: "tws_0123456789abcdef0123456789abcdef:tt_0123456789abcdef0123456789abcdef",
      chatId: "chat_one",
      action: { type: "focus", direction: "right" },
    });
    expect(post).toHaveBeenCalledWith(
      "/api/terminal/workspaces/tws_0123456789abcdef0123456789abcdef/tabs/tt_0123456789abcdef0123456789abcdef/pane-actions?chatId=chat_one",
      { type: "focus", direction: "right" },
    );
  });
  it.each(["right", "down"] as const)(
    "splits %s on a host that predates pane actions",
    async (direction) => {
      const transport = setup();
      await dispatchTerminalPaneRequest({
        ...transport,
        sessionName: "my terminal",
        action: { type: "split", direction },
      });
      expect(transport.post.mock.calls).toEqual([
        [
          "/api/terminal/sessions/my%20terminal/pane-actions",
          { type: "split", direction },
        ],
        ["/api/terminal/sessions/my%20terminal/panes", { direction }],
      ]);
    },
  );
  it("never drops Chat authorization to retry through the standalone route", async () => {
    const transport = setup();
    await expect(
      dispatchTerminalPaneRequest({
        ...transport,
        sessionName: "chat_shell",
        chatId: "chat_one",
        action: { type: "split", direction: "right" },
      }),
    ).rejects.toBeInstanceOf(TerminalPaneActionsUnavailableError);
    expect(transport.post).toHaveBeenCalledTimes(1);
    expect(transport.post).toHaveBeenCalledWith(
      "/api/terminal/sessions/chat_shell/pane-actions?chatId=chat_one",
      { type: "split", direction: "right" },
    );
  });
  it("does not retry failures that could already have executed, or authorization failures", async () => {
    const failed = new Error("timeout or denied");
    const post = vi.fn().mockRejectedValue(failed);
    await expect(
      dispatchTerminalPaneRequest({
        post,
        isMissingRoute: () => false,
        sessionName: "main",
        action: { type: "split", direction: "right" },
      }),
    ).rejects.toBe(failed);
    expect(post).toHaveBeenCalledTimes(1);
  });
  it("reports an update requirement for new actions on old hosts", async () => {
    const transport = setup();
    await expect(
      dispatchTerminalPaneRequest({
        ...transport,
        sessionName: "main",
        action: { type: "focus", direction: "left" },
      }),
    ).rejects.toBeInstanceOf(TerminalPaneActionsUnavailableError);
    expect(transport.post).toHaveBeenCalledTimes(1);
  });
});
