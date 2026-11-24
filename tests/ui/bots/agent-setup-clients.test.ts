import { expect, it, vi } from "vitest";
import type { CanonicalCreateChatTurnRequest } from "@matrix-os/contracts";
import { createCanonicalChatClient } from "../../../desktop/src/renderer/src/lib/canonical-chat-client.js";
import { createApiClient } from "../../../desktop/src/renderer/src/lib/api.js";
import { createCanonicalShellChatClient } from "../../../shell/src/lib/canonical-chat-client.js";

it.each(["Web", "Electron"])("%s negotiates proposal readback only for setup Chats and retains the explicit owner turn", async host => {
  const fetchFn = vi.fn<typeof fetch>(async () => new Response("{}", { status: 400 }));
  const baseUrl = "http://localhost:4000";
  const shell = createCanonicalShellChatClient({ gatewayUrl: baseUrl, fetchFn });
  const desktop = createCanonicalChatClient(createApiClient({ baseUrl, getRuntimeSlot: () => "primary", fetchFn }));
  const client = host === "Web" ? shell : desktop;
  const id = "chat_setup001";
  await expect(client.agents.setupChat!.detail(id)).rejects.toThrow();
  const url = () => new URL(String(fetchFn.mock.lastCall![0]));
  expect(url().searchParams.get("botCreationVersion")).toBe("2");
  await expect(host === "Web" ? shell.detail(id) : desktop.getDetail(id)).rejects.toThrow();
  expect(url().searchParams.has("botCreationVersion")).toBe(false);

  const selection = { instanceId: "matrix_pi_default", model: "sonnet" };
  const input: CanonicalCreateChatTurnRequest = {
    clientRequestId: "req_setup001", baseRevision: 0, selection, interactionMode: "default", permissionMode: "supervised",
    parts: [{ type: "text", text: "Configure a tutor" }], botCreation: {
      sessionId: "setup001", draftRevision: 0,
      seed: { kind: "scratch" }, draft: { name: "", instructions: "", description: "", selection }
    },
  };
  await expect(client.agents.setupChat!.admitTurn(id, input)).rejects.toThrow();
  expect(url().searchParams.get("botCreationVersion")).toBe("2");
  expect(JSON.parse(String(fetchFn.mock.lastCall![1]?.body))).toMatchObject(input);
});
