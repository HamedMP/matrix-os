import { describe, expect, it, vi } from "vitest";
import { TerminalTabClientFrameSchema } from "@matrix-os/contracts";
import { createTerminalSizeLease } from "../../packages/gateway/src/terminal-size-lease.js";

const ref = { workspaceId: `tws_${"a".repeat(32)}`, tabId: `tt_${"b".repeat(32)}` };
describe("terminal sizing lease revocation", () => {
  it("releases a live writer's proposal without disconnecting its observer stream", () => {
    const send = vi.fn();
    const lease = createTerminalSizeLease(ref, send);
    lease.attached();
    expect(send).not.toHaveBeenCalled();
    lease.revoke();
    lease.revoke();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "resize", terminalRef: ref, mode: "soft" }));
    expect(TerminalTabClientFrameSchema.safeParse(send.mock.calls[0]?.[0]).success).toBe(true);
  });
  it("retries release when ownership changes before the runtime stream is assigned", () => {
    let connected = false;
    const sent: unknown[] = [];
    const lease = createTerminalSizeLease(ref, (frame) => { if (connected) sent.push(frame); });
    lease.revoke();
    expect(sent).toEqual([]);
    connected = true;
    lease.attached();
    expect(sent).toEqual([expect.objectContaining({ type: "resize", mode: "soft" })]);
  });
});
