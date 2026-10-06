import { expect, it, vi } from "vitest";
import { createShellApiClient } from "@/api/http";
import { createApiClient } from "@desktop/renderer/src/lib/api";
import { safeMemoryMessage } from "../../packages/ui/src/memory-workspace/model";
for (const surface of ["Web", "Electron"] as const)
  it(`${surface} preserves a conflict without exposing upstream text`, async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ error: "/private/provider/secret" }), {
          status: 409,
          headers: { "content-type": "application/json" },
        }),
      );
    const api =
      surface === "Web"
        ? createShellApiClient({
            getGatewayUrl: () => "https://matrix.test",
            fetchFn,
          })
        : createApiClient({
            baseUrl: "https://matrix.test",
            getRuntimeSlot: () => "primary",
            fetchFn,
          });
    const error = await api
      .patch("/api/memory-workspace/sources/id", { baseRevision: 1 })
      .catch((e) => e);
    expect(error.status).toBe(409);
    expect(error.detail).toBeUndefined();
    expect(safeMemoryMessage(error)).toContain("Your edits are preserved");
    expect(error.message).not.toContain("secret");
  });
