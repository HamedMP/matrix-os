// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { INVOKE_CHANNELS } from "../../desktop/src/shared/ipc-contract";
import { readNativeEmbedBounds } from "../../desktop/src/renderer/src/features/embeds/embed-bounds";

afterEach(() => document.body.replaceChildren());
const rectangle = { x: 10, y: 20, width: 300, height: 200 };
describe("native embed corner geometry", () => {
  it.each([-1, 65, 1.5, Infinity, "12"])("rejects unbounded or invalid radius %s at the IPC boundary", (cornerRadius) => {
    expect(INVOKE_CHANNELS["embed:set-bounds"].request.safeParse({ embedId: "embed-1", bounds: { ...rectangle, cornerRadius } }).success).toBe(false);
  });
  it("allows bounded rounding in both initial and updated native geometry", () => {
    const bounds = { ...rectangle, cornerRadius: 12 };
    expect(INVOKE_CHANNELS["embed:open"].request.safeParse({ kind: "app", slug: "notes", bounds }).success).toBe(true);
    expect(INVOKE_CHANNELS["embed:set-bounds"].request.safeParse({ embedId: "embed-1", bounds }).success).toBe(true);
  });
  it("caps computed rounding and keeps hosts outside OS windows square", () => {
    const frame = document.createElement("section");
    frame.setAttribute("data-os-window", "");
    frame.style.borderBottomLeftRadius = "100px";
    const host = document.createElement("div");
    frame.append(host);
    document.body.append(frame);
    host.getBoundingClientRect = () => ({ left: 10, top: 20, width: 300, height: 200 }) as DOMRect;
    expect(readNativeEmbedBounds(host, 2)).toEqual({ ...rectangle, cornerRadius: 64 });
    document.body.append(host);
    expect(readNativeEmbedBounds(host, 2)).toEqual(rectangle);
  });
});
