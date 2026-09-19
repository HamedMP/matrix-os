import { afterEach, describe, expect, it, vi } from "vitest";
import { deleteTerminalSession } from "../../shell/src/components/terminal/terminal-session-delete";
afterEach(() => vi.unstubAllGlobals());
describe("terminal deletion acknowledgement", () => {
  it("does not remove a row before the backend confirms termination", async () => {
    let done!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { done = resolve; })));
    const confirmed = vi.fn(), error = vi.fn();
    const pending = deleteTerminalSession({ gateway: "https://test.invalid", workspaceId: "workspace", tabId: "tab", confirmed, error });
    expect(confirmed).not.toHaveBeenCalled();
    done(new Response("{}", { status: 200 }));
    await expect(pending).resolves.toBe(true);
    expect(confirmed).toHaveBeenCalledOnce(); expect(error).not.toHaveBeenCalled();
  });
  it("keeps the row and reports a generic error on rejection", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("private failure", { status: 500 })));
    const confirmed = vi.fn(), error = vi.fn();
    await expect(deleteTerminalSession({ gateway: "https://test.invalid", workspaceId: "workspace", tabId: "tab", confirmed, error })).resolves.toBe(false);
    expect(confirmed).not.toHaveBeenCalled(); expect(error).toHaveBeenCalledWith("Failed to remove shell");
  });
});
