// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import { createComposerAcknowledgement } from "@desktop/renderer/src/features/chat/composer-acknowledgement";
import { useConnection } from "@desktop/renderer/src/stores/connection";
import { desktopProviderIdentityKey } from "@desktop/renderer/src/lib/provider-settings-identity";
import { captureRuntimeGeneration, advanceRuntimeGeneration } from "@desktop/renderer/src/stores/runtime-generation";

beforeEach(() => useConnection.setState({ status: "signed-in", userId: "owner_ack", handle: "ack-owner", runtimeSlot: "preview", authGeneration: 1 }));
it.each(["account", "computer", "auth", "generation", "signed-out"])("does not settle another authority's composer after %s changes", change => {
  const settle = vi.fn();
  const ack = createComposerAcknowledgement({ runtimeGeneration: captureRuntimeGeneration(), identity: desktopProviderIdentityKey(useConnection.getState()),
    retained: true, client: "old", currentClient: () => "new", settle });
  if (change === "generation") advanceRuntimeGeneration();
  else useConnection.setState(change === "account" ? { userId: "another_owner" } : change === "computer" ? { runtimeSlot: "another-preview" }
    : change === "auth" ? { authGeneration: 2 } : { status: "signed-out" });
  ack(); expect(settle).not.toHaveBeenCalled();
});
it("keeps local unretained drafts fenced to their original client", () => {
  const settle = vi.fn();
  createComposerAcknowledgement({ runtimeGeneration: captureRuntimeGeneration(), identity: desktopProviderIdentityKey(useConnection.getState()),
    retained: false, client: "old", currentClient: () => "new", settle })();
  expect(settle).not.toHaveBeenCalled();
});
