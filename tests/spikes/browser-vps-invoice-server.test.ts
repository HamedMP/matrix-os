import { request as httpRequest } from "node:http";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { createLabServer, createSupervisor } from "../../scripts/spikes/browser-vps/supervisor.mjs";
import { INVOICE_FIXTURE_EXPECTED } from "../../scripts/spikes/browser-vps/invoices/fixture.mjs";
it("serves the invoice fixture and original attachments through the actual scoped supervisor composition", async () => {
  const supervisor = createSupervisor(); const server = createLabServer(supervisor, "/nonexistent");
  const port = await new Promise<number>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)); });
  const get = (path: string, host = "127.0.0.1:8730") => new Promise<{ status: number; body: Buffer; contentType: string }>((resolve, reject) => {
    const req = httpRequest(`http://127.0.0.1:${port}${path}`, { headers: { Host: host } }, response => {
      const chunks: Buffer[] = []; response.on("data", chunk => chunks.push(chunk)); response.on("end", () => resolve({ status: response.statusCode!, body: Buffer.concat(chunks), contentType: String(response.headers["content-type"]) }));
    }); req.setTimeout(2000, () => req.destroy(new Error("Fixture HTTP deadline"))); req.on("error", reject); req.end();
  });
  try {
    const page = await get("/invoices"); expect(page.status).toBe(200); expect(page.body.toString()).toContain("Page 1 of 2");
    const second = await get("/invoices/page-2"); expect(second.body.toString()).toContain("USD 95.00");
    const original = INVOICE_FIXTURE_EXPECTED.documents[0]; const pdf = await get(original.sourcePath);
    expect(pdf.status).toBe(200); expect(pdf.contentType).toBe("application/pdf"); expect(createHash("sha256").update(pdf.body).digest("hex")).toBe(original.sha256);
    expect((await get("/invoices", "evil.example")).status).toBe(403);
  } finally { await supervisor.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
