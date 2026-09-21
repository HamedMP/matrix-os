import { describe, expect, it } from "vitest";
import { watchResourceStream } from "../../packages/gateway/src/collaboration/resource-routes.js";

describe("bounded collaboration resource streams", () => {
  it("ends a download when the driver sends more bytes than its declared size", async () => {
    const source = new Blob(["more than one byte"]).stream();
    await expect(new Response(watchResourceStream(source, 1, () => true)).text()).rejects.toThrow();
  });

  it("ends a download when its direct lease is no longer active", async () => {
    const source = new Blob(["private content"]).stream();
    await expect(new Response(watchResourceStream(source, 15, () => false)).text()).rejects.toThrow();
  });

  it("streams exact-length bytes while the lease remains active", async () => {
    const source = new Blob(["abc"]).stream();
    expect(await new Response(watchResourceStream(source, 3, () => true)).text()).toBe("abc");
  });
});
