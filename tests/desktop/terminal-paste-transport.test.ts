// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { putTerminalPasteFile } from "@desktop/renderer/src/features/terminal/terminal-paste-transport";

// Fault detected (Greptile, #3570): a file pasted into an ssh-machine terminal (id `vps/t7`) was
// refused before reaching the core, because the paste helper only took this device's ids.
describe("terminal paste transport", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("puts a pasted file beside a terminal on an ssh machine", async () => {
    const invoke = vi.fn(async () => ({ ok: true, path: "/home/me/.hc/t7/shot.png" }));
    window.operator = { invoke, on: () => () => undefined } as unknown as typeof window.operator;
    await expect(putTerminalPasteFile({
      sessionName: "local:vps/t7", api: null, name: "shot.png", mimeType: "image/png", dataBase64: "aGk=", size: 2, kind: "image",
    })).resolves.toBe("/home/me/.hc/t7/shot.png");
    expect(invoke).toHaveBeenCalledWith("local-terminal:put", { id: "vps/t7", name: "shot.png", dataBase64: "aGk=" });
  });

  it("refuses an address that is neither this device's terminal nor a machine's", async () => {
    window.operator = { invoke: vi.fn(), on: () => () => undefined } as unknown as typeof window.operator;
    await expect(putTerminalPasteFile({
      sessionName: "local:../t7", api: null, name: "shot.png", mimeType: "image/png", dataBase64: "aGk=", size: 2, kind: "image",
    })).rejects.toThrow();
  });
});
