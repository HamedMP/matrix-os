import { describe, expect, it, vi } from "vitest";
import { assertSlackPreviewOwner, registerSlackPreviewHome } from "../../scripts/slack-preview-runtime.mjs";

describe("Slack preview runtime ownership gate", () => {
  it("queries for exactly one active installation linked to the runtime owner", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ installations: 1, linked_teams: 1 }] });
    await expect(assertSlackPreviewOwner({ query }, { appId: "A0C67MMARMJ", ownerId: "user_hamed" })).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledWith(expect.stringContaining("i.state = 'active'"), ["A0C67MMARMJ", "user_hamed"]);
  });

  it.each([
    { installations: 0, linked_teams: 0 },
    { installations: 2, linked_teams: 2 },
    { installations: 1, linked_teams: 0 },
  ])("rejects an absent, ambiguous, or differently owned link (%o)", async (row) => {
    const query = vi.fn().mockResolvedValue({ rows: [row] });
    await expect(assertSlackPreviewOwner({ query }, { appId: "A0C67MMARMJ", ownerId: "user_hamed" }))
      .rejects.toMatchObject({ code: "slack_owner_mismatch" });
  });

  it("rejects malformed identity input before querying the database", async () => {
    const query = vi.fn();
    await expect(assertSlackPreviewOwner({ query }, { appId: "bad", ownerId: "user_hamed" }))
      .rejects.toMatchObject({ code: "invalid_input" });
    expect(query).not.toHaveBeenCalled();
  });

  it("does not register a runtime when the linked Slack account has a different owner", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ installations: 0, linked_teams: 0 }], rowCount: 0 });
    await expect(registerSlackPreviewHome({ query }, {
      handle: "pr-2079",
      machineId: "3f6b1a2c-4d5e-4f60-8a7b-9c0d1e2f3a4b",
      ownerId: "user_hamed",
      address: "192.0.2.10",
    }, "A0C67MMARMJ")).rejects.toMatchObject({ code: "slack_owner_mismatch" });
    expect(query).toHaveBeenCalledOnce();
  });
});
