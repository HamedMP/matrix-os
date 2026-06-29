import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const clerk = vi.hoisted(() => ({
  userId: "user_123" as string | null,
  updateUserMetadata: vi.fn(async () => ({})),
}));

vi.mock("@clerk/nextjs/server", () => ({
  auth: async () => ({ userId: clerk.userId }),
  clerkClient: async () => ({ users: { updateUserMetadata: clerk.updateUserMetadata } }),
}));

async function loadRoute() {
  vi.resetModules();
  return await import("../../www/src/app/welcome/route");
}

describe("/welcome metadata handoff", () => {
  beforeEach(() => {
    clerk.userId = "user_123";
    clerk.updateUserMetadata.mockClear();
    clerk.updateUserMetadata.mockResolvedValue({});
    process.env.NEXT_PUBLIC_MATRIX_APP_URL = "https://app.matrix-os.com";
  });
  afterEach(() => vi.restoreAllMocks());

  it("writes the selected plan to public metadata and redirects to the app root", async () => {
    const { GET } = await loadRoute();
    const res = await GET(new Request("https://matrix-os.com/welcome?plan=builder"));
    expect(clerk.updateUserMetadata).toHaveBeenCalledWith("user_123", {
      publicMetadata: { selectedPlan: "matrix_builder" },
    });
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://app.matrix-os.com");
  });

  it("ignores an invalid plan but still redirects", async () => {
    const { GET } = await loadRoute();
    const res = await GET(new Request("https://matrix-os.com/welcome?plan=enterprise"));
    expect(clerk.updateUserMetadata).not.toHaveBeenCalled();
    expect(res.headers.get("location")).toBe("https://app.matrix-os.com");
  });

  it("does not write metadata for an anonymous request", async () => {
    clerk.userId = null;
    const { GET } = await loadRoute();
    const res = await GET(new Request("https://matrix-os.com/welcome?plan=builder"));
    expect(clerk.updateUserMetadata).not.toHaveBeenCalled();
    expect(res.headers.get("location")).toBe("https://app.matrix-os.com");
  });

  it("redirects even when the metadata write throws", async () => {
    clerk.updateUserMetadata.mockRejectedValueOnce(new Error("clerk down"));
    const { GET } = await loadRoute();
    const res = await GET(new Request("https://matrix-os.com/welcome?plan=builder"));
    expect(res.headers.get("location")).toBe("https://app.matrix-os.com");
  });
});
