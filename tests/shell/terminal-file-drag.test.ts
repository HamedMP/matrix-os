// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { captureTerminalFileDrag } from "../../packages/ui/src/terminal/terminal-file-drag";

describe("Terminal file drag metadata", () => {
  it.each([
    { payload: null, accepted: false },
    { payload: {}, accepted: false },
    { payload: { types: ["text/plain"] }, accepted: false },
    { payload: { items: [{ kind: "string" }] }, accepted: false },
    { payload: { types: ["Files"] }, accepted: true },
    { payload: { items: [{ kind: "file", type: "" }] }, accepted: true },
  ])("accepts only file metadata: $payload", ({ payload, accepted }) => {
    const event = new Event("dragover", { cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: payload });
    captureTerminalFileDrag(event as DragEvent);
    expect(event.defaultPrevented).toBe(accepted);
    if (accepted) expect(payload).toHaveProperty("dropEffect", "copy");
  });
});
