import { describe, expect, it } from "vitest";
import { getVpsBootPage } from "../../packages/platform/src/auth-pages.js";

describe("platform Figma boot screen", () => {
  it.each(["provisioning", "starting", "recovering"])("keeps %s accessible and automatically retries", (status) => {
    const html = getVpsBootPage({ status });
    expect(html).toContain('http-equiv="refresh" content="8"');
    expect(html).toContain('class="matrix-boot-screen"');
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain(status === "recovering" ? "Restoring Matrix OS" : "Booting Matrix OS");
    expect(html).toContain("#0D0C0C");
    expect(html).toContain("data:image/svg+xml;base64,");
    expect(html).toContain("matrix-boot-gradient 4s linear infinite");
    expect(html).toContain("prefers-reduced-motion: reduce");
    expect(html).not.toContain('class="wordmark"');
    expect(html).not.toContain("Instance status:");
    expect(html).not.toContain("figma.com/api/mcp/asset");
  });

  it("does not interpolate untrusted status into markup", () => {
    const html = getVpsBootPage({ status: '<img src=x onerror="alert(1)">' });
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("<img src=x");
  });
});

describe("platform boot screen for an on-demand computer (ENG-520)", () => {
  it("says a sleeping computer is waking, not booting, and checks back sooner", () => {
    const html = getVpsBootPage({ status: "waking" });
    expect(html).toContain("<title>Waking your Matrix computer</title>");
    expect(html).toContain("Matrix is waking your computer. It opens in a few seconds.");
    expect(html).toContain('http-equiv="refresh" content="3"');
    expect(html).not.toContain("couple of minutes");
  });

  it("says Matrix is at capacity when a wake cannot be placed", () => {
    const html = getVpsBootPage({ status: "busy" });
    expect(html).toContain("<title>Matrix is at capacity</title>");
    expect(html).toContain("Matrix is at capacity right now. Try again in a minute.");
    expect(html).not.toContain("Booting Matrix OS");
  });
});
