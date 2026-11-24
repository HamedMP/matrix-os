import type { MessageBoxOptions } from "electron";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { installRendererRecovery } from "../../desktop/src/main/renderer-recovery";

function setup() {
  const contents = Object.assign(new EventEmitter(), { isDestroyed: vi.fn(() => false), reload: vi.fn() });
  const window = Object.assign(new EventEmitter(), { webContents: contents, isDestroyed: vi.fn(() => false), close: vi.fn(), show: vi.fn() });
  let respond!: (value: { response: number }) => void;
  const showMessage = vi.fn((_options: MessageBoxOptions) => new Promise<{ response: number }>((resolve) => { respond = resolve; }));
  const reportError = vi.fn();
  installRendererRecovery(window, { showMessage, reportError });
  return { contents, window, showMessage, reportError, respond: (response: number) => respond({ response }) };
}
const flush = async () => { await new Promise<void>((resolve) => setImmediate(resolve)); };

describe("native renderer recovery", () => {
  it.each(["killed", "crashed", "oom", "launch-failed"])("offers an explicit reload after %s instead of leaving an inert window", async (reason) => {
    const s = setup();
    s.contents.emit("render-process-gone", {}, { reason, exitCode: 9 });
    expect(s.showMessage).toHaveBeenCalledOnce();
    expect(s.showMessage.mock.calls[0]?.[0]).toMatchObject({ buttons: ["Reload window", "Close window"], message: "Matrix OS couldn’t open this window", cancelId: 1 });
    expect(s.contents.reload).not.toHaveBeenCalled();
    s.respond(0);
    await flush();
    expect(s.contents.reload).toHaveBeenCalledOnce();
    expect(s.window.close).not.toHaveBeenCalled();
  });

  it("recovers a main-frame load failure without disclosing the URL or network diagnostic", async () => {
    const s = setup();
    s.contents.emit("did-fail-load", {}, -6, "private diagnostic", "file:///private/example?token=synthetic", true);
    expect(s.window.show).toHaveBeenCalledOnce();
    expect(JSON.stringify(s.showMessage.mock.calls)).not.toMatch(/private|synthetic|file:/);
    s.respond(1);
    await flush();
    expect(s.window.close).toHaveBeenCalledOnce();
    expect(s.contents.reload).not.toHaveBeenCalled();
  });

  it("ignores aborted navigation, subframe errors, and clean renderer exits", () => {
    const s = setup();
    s.contents.emit("did-fail-load", {}, -3, "ERR_ABORTED", "file:///app", true);
    s.contents.emit("did-fail-load", {}, -6, "missing", "file:///embedded", false);
    s.contents.emit("render-process-gone", {}, { reason: "clean-exit", exitCode: 0 });
    expect(s.showMessage).not.toHaveBeenCalled();
  });

  it("coalesces concurrent failure events but allows recovery after a later failure", async () => {
    const s = setup();
    s.contents.emit("render-process-gone", {}, { reason: "killed", exitCode: 9 });
    s.contents.emit("did-fail-load", {}, -6, "missing", "file:///app", true);
    expect(s.showMessage).toHaveBeenCalledOnce();
    s.respond(0);
    await flush();
    s.contents.emit("render-process-gone", {}, { reason: "crashed", exitCode: 1 });
    expect(s.showMessage).toHaveBeenCalledTimes(2);
  });

  it("removes listeners and ignores a pending response when its window closes", async () => {
    const s = setup();
    s.contents.emit("render-process-gone", {}, { reason: "killed", exitCode: 9 });
    s.window.emit("closed");
    s.respond(0);
    await flush();
    expect(s.contents.reload).not.toHaveBeenCalled();
    expect(s.contents.listenerCount("render-process-gone")).toBe(0);
    expect(s.contents.listenerCount("did-fail-load")).toBe(0);
  });

  it("does not touch destroyed contents when the owner responds late", async () => {
    const s = setup();
    s.contents.emit("render-process-gone", {}, { reason: "killed", exitCode: 9 });
    s.contents.isDestroyed.mockReturnValue(true);
    s.respond(0);
    await flush();
    expect(s.contents.reload).not.toHaveBeenCalled();
  });

  it("reports a failed dialog without an unhandled rejection or automatic reload", async () => {
    const s = setup();
    s.showMessage.mockRejectedValueOnce(new Error("Synthetic dialog failure"));
    s.contents.emit("render-process-gone", {}, { reason: "killed", exitCode: 9 });
    await flush();
    expect(s.reportError).toHaveBeenCalledOnce();
    expect(s.contents.reload).not.toHaveBeenCalled();
  });
});
