import { Readable } from "node:stream";
import { JSDOM } from "jsdom";
import { expect, it, vi } from "vitest";
import { createInvoiceFixture } from "../../scripts/spikes/browser-vps/invoices/fixture.mjs";

it("recovers the owner Continue button when its bounded request stalls", async () => {
  const fixture = createInvoiceFixture({ requireOwnerLogin: true });
  const request = Object.assign(Readable.from([]), { method: "GET", headers: {} });
  const response = await fixture.respond(request, new URL("http://127.0.0.1:8730/invoices/owner-login"));
  const controller = new AbortController();
  let timeoutMs = 0;
  let fetchSignal: AbortSignal | undefined;
  const dom = new JSDOM(String(response.body), {
    url: "http://127.0.0.1:8730/invoices/owner-login",
    runScripts: "dangerously",
    beforeParse(window) {
      Object.defineProperty(window.AbortSignal, "timeout", { value: (ms: number) => { timeoutMs = ms; return controller.signal; } });
      window.fetch = ((_: string, init: RequestInit) => {
        fetchSignal = init.signal as AbortSignal | undefined;
        return new Promise((_resolve, reject) => fetchSignal?.addEventListener("abort", () => reject(new window.DOMException("Aborted", "AbortError")), { once: true }));
      }) as typeof window.fetch;
    },
  });
  try {
    const button = dom.window.document.getElementById("owner-continue") as HTMLButtonElement;
    button.click();
    expect(button.disabled).toBe(true);
    expect(timeoutMs).toBe(10_000);
    expect(fetchSignal).toBe(controller.signal);
    controller.abort();
    await vi.waitFor(() => expect(button.disabled).toBe(false));
    expect(dom.window.document.getElementById("owner-result")?.textContent).toContain("unavailable");
  } finally { dom.window.close(); }
});
