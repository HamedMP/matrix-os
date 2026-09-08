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
