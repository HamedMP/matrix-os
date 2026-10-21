// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ProviderAccessSource, ProviderAccount, ProviderHarnessInstance } from "../../packages/contracts/src/index.js";
import { ConnectedAccountCard } from "../../packages/ui/src/agents-providers/ConnectedAccountCard.js";

const unavailableUsage = { kind: "unavailable", authority: "unavailable", state: "not_applicable", scope: "account", reason: "unknown", asOf: null };
const claude = { id: "harness_claude_code", harness: "claude", displayName: "Claude Code" } as unknown as ProviderHarnessInstance;
const keySource = { id: "owner_anthropic_key", providerId: "anthropic", fundingKind: "owner_api_key", displayName: "Anthropic API key", usage: unavailableUsage } as unknown as ProviderAccessSource;
const keyAccount = { id: "owner_anthropic", providerId: "anthropic", authMethod: "api_key", displayName: "anthropic account" } as unknown as ProviderAccount;

describe("connection card for an owner API key", () => {
  it("names the billing provider instead of a raw account id or a usage reading the provider never shares", () => {
    render(<ConnectedAccountCard harness={claude} account={keyAccount} source={keySource} disabled={false} onRefresh={vi.fn()} />);
    expect(screen.getByText("API key")).toBeVisible();
    expect(screen.getByText("Billed per request by Anthropic")).toBeVisible();
    expect(screen.queryByText("Usage unavailable")).not.toBeInTheDocument();
    expect(screen.queryByText("anthropic account")).not.toBeInTheDocument();
  });

  it("keeps the usage line for a subscription account", () => {
    const profile = { ...keySource, id: "owner_claude_profile", fundingKind: "owner_account" } as unknown as ProviderAccessSource;
    const account = { ...keyAccount, id: "owner_claude_profile", authMethod: "terminal", displayName: "Claude account" } as unknown as ProviderAccount;
    render(<ConnectedAccountCard harness={claude} account={account} source={profile} disabled={false} onRefresh={vi.fn()} />);
    expect(screen.getByText("Usage unavailable")).toBeVisible();
  });
});
