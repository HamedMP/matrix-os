import { describe, expect, it, vi } from "vitest";
import {
  CustomMcpUrlError,
  validateCustomMcpUrl,
} from "../../packages/gateway/src/integrations/custom-mcp/security.js";

describe("Custom MCP remote URL validation", () => {
  const resolvePublic = vi.fn(async () => [{ address: "93.184.216.34", family: 4 as const }]);

  it("accepts HTTPS and returns the DNS-pinned public address", async () => {
    const result = await validateCustomMcpUrl("https://mcp.acme.tools/tools", resolvePublic);
    expect(result.url.href).toBe("https://mcp.acme.tools/tools");
    expect(result.address).toBe("93.184.216.34");
  });

  it("accepts public HTTPS servers on explicit ports and IPv6 literals", async () => {
    await expect(validateCustomMcpUrl("https://mcp.acme.tools:8443/mcp", resolvePublic)).resolves.toMatchObject({ address: "93.184.216.34" });
    await expect(validateCustomMcpUrl("https://[2606:4700:4700::1111]/mcp", resolvePublic)).resolves.toMatchObject({ family: 6 });
  });

  it.each([
    "http://mcp.example.com/mcp",
    "https://user:pass@mcp.example.com/mcp",
    "https://mcp.example.com/mcp#fragment",
    "https://localhost/mcp",
    "https://127.0.0.1/mcp",
    "https://169.254.169.254/latest/meta-data",
    "https://192.0.2.10/mcp",
    "https://224.0.0.1/mcp",
  ])("rejects unsafe URL %s", async (url) => {
    await expect(validateCustomMcpUrl(url, resolvePublic)).rejects.toBeInstanceOf(CustomMcpUrlError);
  });

  it("rejects DNS rebinding targets before a request is sent", async () => {
    await expect(validateCustomMcpUrl(
      "https://mcp.acme.tools/mcp",
      vi.fn(async () => [{ address: "10.0.0.9", family: 4 as const }]),
    )).rejects.toBeInstanceOf(CustomMcpUrlError);
  });
});
