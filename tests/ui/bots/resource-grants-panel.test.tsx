// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BotResourceGrantsPanel } from "../../../packages/ui/src/chat-agents/bots/BotResourceGrantsPanel.js";

const agentId = "bot_reviewer123";
const channel = { id: "source_channel", kind: "slack_channel", label: "#review-sandbox" } as const;
const repository = { id: "source_repo", kind: "github_repository", label: "demo/reviewer-sandbox" } as const;
const grant = { id: "rgr_reviewer1", kind: repository.kind, label: repository.label, revision: 1 } as const;

afterEach(cleanup);

describe("Agent resource grants", () => {
  it("grants only the resource selected by the owner and reopens from the server", async () => {
    const list = vi.fn().mockResolvedValueOnce({ candidates: [channel, repository], grants: [] })
      .mockResolvedValue({ candidates: [channel], grants: [grant] });
    const save = vi.fn().mockResolvedValue({ grant });
    const revoke = vi.fn();
    const client = { list, grant: save, revoke };
    const first = render(<BotResourceGrantsPanel agentId={agentId} client={client} />);
    fireEvent.click(await screen.findByRole("button", { name: "Grant read access to demo/reviewer-sandbox" }));
    await screen.findByText("demo/reviewer-sandbox · Read only");
    expect(save).toHaveBeenCalledExactlyOnceWith(agentId, repository.id);
    expect(revoke).not.toHaveBeenCalled();
    first.unmount();
    render(<BotResourceGrantsPanel agentId={agentId} client={client} />);
    await screen.findByText("demo/reviewer-sandbox · Read only");
    expect(list).toHaveBeenCalledWith(agentId);
    expect(screen.getByRole("button", { name: "Grant read access to #review-sandbox" })).toBeTruthy();
  });

  it("shows unavailable resources without offering any broader account grant", async () => {
    const client = { list: vi.fn().mockResolvedValue({ candidates: [], grants: [] }), grant: vi.fn(), revoke: vi.fn() };
    render(<BotResourceGrantsPanel agentId={agentId} client={client} />);
    await screen.findByText("No approved Slack channels are available.");
    expect(screen.getByText("No approved GitHub repositories are available.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /grant read access/i })).toBeNull();
    expect(client.grant).not.toHaveBeenCalled();
  });

  it("keeps a saved grant visible after a failed revoke and does not disclose raw errors", async () => {
    const client = { list: vi.fn().mockResolvedValue({ candidates: [], grants: [grant] }), grant: vi.fn(),
      revoke: vi.fn().mockRejectedValue(new Error("internal data source /home/matrix")) };
    render(<BotResourceGrantsPanel agentId={agentId} client={client} />);
    fireEvent.click(await screen.findByRole("button", { name: "Revoke read access to demo/reviewer-sandbox" }));
    await waitFor(() => expect(client.revoke).toHaveBeenCalledExactlyOnceWith(agentId, grant.id, grant.revision));
    expect((await screen.findByRole("alert")).textContent).not.toContain("/home/matrix");
    expect(screen.getByText("demo/reviewer-sandbox · Read only")).toBeTruthy();
  });
});

it("uses the Agent resource endpoints with only the candidate and revision in mutation bodies", async () => {
  const { createBotClient } = await import("../../../packages/ui/src/chat-agents/bots/client.js");
  const candidate = { ...repository, id: "source_" + "a".repeat(48) };
  const saved = { ...grant, id: "rgr_" + "b".repeat(32) };
  const request = vi.fn().mockResolvedValueOnce({ candidates: [candidate], grants: [] })
    .mockResolvedValueOnce({ grant: saved })
    .mockResolvedValueOnce({ grantId: saved.id, revokedAt: "2026-11-26T06:00:00.000Z" });
  const client = createBotClient(request).resourceGrants!;
  const path = "/api/chat-agents/" + agentId + "/resource-grants";

  await expect(client.list(agentId)).resolves.toEqual({ candidates: [candidate], grants: [] });
  await client.grant(agentId, candidate.id);
  await client.revoke(agentId, saved.id, saved.revision);

  expect(request.mock.calls).toEqual([
    [path, "GET", undefined],
    [path, "POST", { candidateId: candidate.id }],
    [path + "/" + saved.id, "DELETE", { baseRevision: saved.revision }],
  ]);
});
