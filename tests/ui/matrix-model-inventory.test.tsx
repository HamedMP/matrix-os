// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { GatewayPanel } from "../../packages/ui/src/agents-providers/GatewayPanel";

afterEach(cleanup);
it.each([false, true])("shows each offered model once while an unavailable route stays unusable (duplicate funding source: %s)", (duplicateFundingSource) => {
  render(<GatewayPanel source={{ id: "matrix_included", readiness: { state: "unavailable", action: "retry", safeReason: "provider_unavailable" },
    eligibleModelIds: [], usage: { kind: "unavailable", reason: "unknown" } } as never}
    policy={{ accessSourceId: "matrix_included", allowedModelIds: [], monthlyBudgetMicrousd: null, topUpEnabled: false }} provider={null}
    modelInventory={[
      { id: "claude-sonnet-5", displayName: "Claude Sonnet 5", enabled: true, providerId: "anthropic", accessSourceId: "matrix_included", capabilities: ["tools"] },
      { id: "@cf/zai-org/glm-5.3-flash", displayName: "GLM 5.3 Flash", enabled: true, providerId: "cloudflare", accessSourceId: "matrix_cloudflare" },
      ...(duplicateFundingSource ? [{ id: "claude-sonnet-5", displayName: "Claude Sonnet 5", enabled: true, providerId: "anthropic" as const, accessSourceId: "matrix_addon" }] : []),
    ]} disabled={false} canSetBudget={false} canSetAllowlist={false} canAddCredit={false}
    onMutate={vi.fn()} onAddCredit={vi.fn()} onRefresh={vi.fn()} onUseGateway={vi.fn()} />);
  expect(screen.getAllByText("Claude Sonnet 5")).toHaveLength(1);
  expect(screen.getByText("Claude Sonnet 5")).toBeVisible();
  expect(screen.getByText("GLM 5.3 Flash")).toBeVisible();
  expect(screen.queryByText("No models are enabled for this computer.")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Use Matrix/ })).not.toBeInTheDocument();
});
