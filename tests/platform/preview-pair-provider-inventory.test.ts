import { describe, expect, it, vi } from "vitest";
import { createHetznerClient } from "../../packages/platform/src/customer-vps-hetzner.js";
import { createTestConfig } from "./customer-vps-service-test-helper.js";

describe("cleanup inventory preserves the actual provider pagination boundary", () => {
  it.each([null, 2])("reports completeness from provider metadata (next page %s)", async next => {
    const fetcher = vi.fn(async () => Response.json({ servers: [], meta: { pagination: { page: 1, next_page: next } } }));
    const client = createHetznerClient(createTestConfig(), fetcher);
    expect(await client.inspectServersByLabel!("machine_id=11111111-1111-4111-8111-111111111111"))
      .toEqual({ servers: [], complete: next === null });
    expect(String(fetcher.mock.calls[0]?.[0])).toContain("per_page=50&page=1");
  });
  it("rejects missing pagination instead of claiming no labeled orphan exists", async () => {
    const client = createHetznerClient(createTestConfig(), vi.fn(async () => Response.json({ servers: [] })));
    await expect(client.inspectServersByLabel!("machine_id=11111111-1111-4111-8111-111111111111")).rejects.toThrow("unavailable");
  });
});
