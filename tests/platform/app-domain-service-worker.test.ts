import { describe, expect, it } from "vitest";
import { appDomainServiceWorkerResponse } from "../../packages/platform/src/app-domain-service-worker.js";

describe("platform app-domain service worker", () => {
  it("activates updated routing for open tabs and bypasses explicit VM routes", async () => {
    const response = appDomainServiceWorkerResponse();
    const source = await response.text();

    expect(source).toContain('self.addEventListener("install"');
    expect(source).toContain("self.skipWaiting()");
    expect(source).toContain('p.startsWith("/vm/")');
  });
});
