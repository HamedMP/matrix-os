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

  it("never delivers a chunk whose lease ended while the read was in flight", async () => {
    let active = true;
    const chunks = ["first", "second"].map((part) => new TextEncoder().encode(part));
    let index = 0;
    const source = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const chunk = chunks[index];
        index += 1;
        if (!chunk) {
          controller.close();
          return;
        }
        // Revocation lands while this read is pending, after the watch checked the lease.
        if (index === 2) {
          await Promise.resolve();
          active = false;
        }
        controller.enqueue(chunk);
      },
    });
    const delivered = await drain(watchResourceStream(source, 11, () => active));
    expect(delivered).toEqual({ text: "first", errored: true });
  });
});

/** Collects what a consumer actually receives, and whether the stream ended in an error. */
async function drain(stream: ReadableStream<Uint8Array>): Promise<{ text: string; errored: boolean }> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    try {
      const next = await reader.read();
      if (next.done) return { text, errored: false };
      text += decoder.decode(next.value);
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(Error);
      return { text, errored: true };
    }
  }
}
