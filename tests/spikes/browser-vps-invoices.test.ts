import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { createInvoiceFixture, INVOICE_FIXTURE_EXPECTED } from "../../scripts/spikes/browser-vps/invoices/fixture.mjs";
const url = (path: string) => new URL(path, "http://127.0.0.1:8730");
const request = (method = "GET", body?: unknown) => Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), { method, headers: { "content-type": "application/json" } });
it("exposes two clearly synthetic pagination pages with duplicates and displayed metadata conflicts", async () => {
  const fixture = createInvoiceFixture();
  const first = await fixture.respond(request(), url("/invoices")); const second = await fixture.respond(request(), url("/invoices/page-2"));
  expect(first.status).toBe(200); expect(second.status).toBe(200);
  expect(String(first.body)).toMatch(/SYNTHETIC.*NOT PAYABLE/); expect(String(first.body)).toContain("Page 1 of 2");
  expect(String(first.body)).toContain("EUR 144.00"); expect(String(first.body)).toContain("EUR 90.00");
  expect(String(second.body)).toContain("Page 2 of 2"); expect(String(second.body)).toContain("USD 95.00");
  expect(INVOICE_FIXTURE_EXPECTED).toMatchObject({ pageCount: 2, rowCount: 4, uniqueDocumentCount: 2,
    conflicts: [{ documentId: "SYN_INV_002", displayedCurrency: "USD", displayedTotal: "95.00", originalCurrency: "EUR", originalTotal: "90.00" }] });
});
it("serves deterministic original valid PDF attachments with exact manifest hashes and real xref offsets", async () => {
  const fixture = createInvoiceFixture();
  for (const doc of INVOICE_FIXTURE_EXPECTED.documents) {
    const response = await fixture.respond(request(), url(doc.sourcePath)); const bytes = Buffer.from(response.body);
    expect(response.status).toBe(200); expect(response.headers["Content-Type"]).toBe("application/pdf");
    expect(response.headers["Content-Disposition"]).toBe(`attachment; filename="${doc.documentId}.pdf"`);
    expect(bytes.subarray(0,8).toString()).toBe("%PDF-1.4"); expect(bytes.toString()).toContain(`${doc.currency} ${doc.total}`);
    expect(bytes.toString()).toContain("SYNTHETIC - NOT PAYABLE"); expect(bytes.byteLength).toBe(doc.size);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(doc.sha256);
    const trailer = /startxref\n(\d+)\n%%EOF/.exec(bytes.toString())!; expect(trailer).not.toBeNull();
    const xref = Number(trailer[1]); expect(bytes.subarray(xref, xref+4).toString()).toBe("xref");
    const entries = bytes.subarray(xref).toString().split("\n").slice(3,8);
    entries.forEach((entry, index) => expect(bytes.subarray(Number(entry.slice(0,10))).toString()).toMatch(new RegExp(`^${index+1} 0 obj`)));
  }
});
it("bounds credential-free synthetic handoff/reset with epoch guards and no real login material", async () => {
  const fixture = createInvoiceFixture({ requireOwnerLogin: true });
  const handoff = await fixture.respond(request(), url("/invoices")); expect(String(handoff.body)).toContain("Continue synthetic owner handoff");
  expect(String(handoff.body)).not.toMatch(/type="password"|secret key|passkey/i);
  expect((await fixture.respond(request("POST", { epoch: 0, acknowledge: "synthetic-only" }), url("/invoices/owner-login"))).status).toBe(200);
  expect(String((await fixture.respond(request(), url("/invoices"))).body)).toContain("Page 1 of 2");
  expect((await fixture.respond(request("POST", { epoch: 0 }), url("/invoices/reset"))).status).toBe(200);
  expect((await fixture.respond(request("POST", { epoch: 0, acknowledge: "synthetic-only" }), url("/invoices/owner-login"))).status).toBe(409);
  expect((await fixture.respond(request("POST", { epoch: 1, acknowledge: "synthetic-only", ownerId: "spoof" }), url("/invoices/owner-login"))).status).toBe(400);
  expect(String((await fixture.respond(request(), url("/invoices"))).body)).toContain("Continue synthetic owner handoff");
});
it("does not expand past its fixed subtree and refuses malformed paths, methods and oversized mutation bodies", async () => {
  const fixture = createInvoiceFixture();
  expect(await fixture.respond(request(), url("/fixture"))).toBeNull();
  expect((await fixture.respond(request(), url("/invoices/missing.pdf"))).status).toBe(404);
  expect((await fixture.respond(request("DELETE"), url("/invoices"))).status).toBe(405);
  expect((await fixture.respond(request("POST", { epoch: 0, padding: "x".repeat(3000) }), url("/invoices/reset"))).status).toBe(413);
});
