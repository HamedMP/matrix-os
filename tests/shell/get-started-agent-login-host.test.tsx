// @vitest-environment jsdom
import React from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

let gatewayUrl = "http://owner.local";
vi.mock("@/lib/gateway", () => ({ getGatewayUrl: () => gatewayUrl }));
vi.mock("@/lib/ai-credit-checkout", () => ({ currentAiCreditRuntimeSlot: () => "primary" }));
const controllerOptions: Array<{ onCatalogChanged?: () => void }> = [];
vi.mock("@matrix-os/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@matrix-os/ui")>()),
  useProviderSettingsController: (options: { onCatalogChanged?: () => void }) => {
    controllerOptions.push(options);
    return { snapshot: null, error: null, refresh: vi.fn() };
  },
  GetStartedAgentLogin: () => null,
}));

import { ShellGetStartedAgentLogin } from "../../shell/src/components/get-started/ShellGetStartedAgentLogin";
import { PROVIDER_SETTINGS_CHANGED_EVENT } from "../../shell/src/lib/canonical-provider-setup";

afterEach(() => {
  cleanup();
  gatewayUrl = "http://owner.local";
});

describe("Web Get started agent sign-in", () => {
  it("tells an open Chat when a sign-in changes this computer's agents, never another computer's", () => {
    const changed = vi.fn();
    window.addEventListener(PROVIDER_SETTINGS_CHANGED_EVENT, changed);
    try {
      render(<ShellGetStartedAgentLogin agent="claude" />);
      const onCatalogChanged = controllerOptions.at(-1)?.onCatalogChanged;
      expect(onCatalogChanged).toBeTypeOf("function");
      onCatalogChanged?.();
      expect(changed).toHaveBeenCalledTimes(1);
      // After switching computers, a late result from the old one stays quiet.
      gatewayUrl = "http://other.local";
      onCatalogChanged?.();
      expect(changed).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener(PROVIDER_SETTINGS_CHANGED_EVENT, changed);
    }
  });
});
