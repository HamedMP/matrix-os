// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ChatUsagePanel } from "../../packages/ui/src/chat-usage/ChatUsagePanel.js";
import type { ChatUsageClient, ChatUsagePolicy, ChatUsageSummary } from "../../packages/ui/src/chat-usage/client.js";

afterEach(cleanup);
const policy: ChatUsagePolicy = { enabled: false, sampleRateBps: 1000, modelId: "@cf/meta/classifier", recipient: "Cloudflare Workers AI",
  disclosureVersion: "chat-usage-v1", retentionDays: 30 };
const summary: ChatUsageSummary = { from: "2026-10-18T12:00:00.000Z", to: "2026-10-25T12:00:00.000Z", groupLimit: 100,
  mayBeTruncated: false, classificationIsEstimate: true, buckets: [{ dimensions: { taskFamily: "coding" },
    generations: 4, sampled: 2, classified: 1, inputTokens: 100, outputTokens: null, cachedInputTokens: null, costUsd: null,
    latencyMsMean: 350, unknownInputTokenGenerations: 1, unknownOutputTokenGenerations: 4,
    unknownCachedInputTokenGenerations: 4, unknownCostGenerations: 4, unknownLatencyGenerations: 2,
    samplingRateBpsMin: 1000, samplingRateBpsMax: 2500 }] };
function client() { return { policy: vi.fn<ChatUsageClient["policy"]>().mockResolvedValue(policy), summary: vi.fn<ChatUsageClient["summary"]>().mockResolvedValue(summary),
  configure: vi.fn<ChatUsageClient["configure"]>().mockResolvedValue({ ...policy, enabled: true }), deleteData: vi.fn<ChatUsageClient["deleteData"]>().mockResolvedValue({ deleted: true, enabled: false }) }; }
async function ready() { await screen.findByRole("button", { name: "Enable Chat usage" }); }

it("shows loading and unavailable states without presenting false zero usage", async () => {
  const api = client(); api.policy.mockRejectedValue(new Error("private provider URL"));
  render(<ChatUsagePanel client={api} identityKey="owner/runtime" />);
  expect(screen.getByRole("status")).toHaveTextContent("Loading Chat usage");
  await screen.findByRole("button", { name: "Retry Chat usage" });
  expect(screen.getByRole("alert")).toHaveTextContent("Chat usage is unavailable");
  expect(screen.queryByText("private provider URL")).toBeNull();
  expect(screen.queryByText("No recorded generations")).toBeNull();
  api.policy.mockResolvedValue(policy); fireEvent.click(screen.getByRole("button", { name: "Retry Chat usage" })); await ready();
});
it("requires explicit normal in-app consent with exact scope and recipient before enable", async () => {
  const api = client(); render(<ChatUsagePanel client={api} identityKey="owner/runtime" />); await ready();
  const enable = screen.getByRole("button", { name: "Enable Chat usage" }); expect(enable).toBeDisabled();
  expect(screen.getByText(/Cloudflare Workers AI/)).toBeVisible();
  expect(screen.getByText(/Matrix AI credits/)).toBeVisible();
  expect(screen.getByText(/Gmail, shared, imported and unknown/)).toBeVisible();
  expect(screen.getByText(/Matrix Pi Chat and Bots/)).toBeVisible();
  expect(screen.getByText(/30 days/)).toBeVisible();
  fireEvent.change(screen.getByLabelText("Sampling"), { target: { value: "2500" } });
  fireEvent.click(screen.getByRole("checkbox", { name: /I agree/ })); fireEvent.click(enable);
  await waitFor(() => expect(api.configure).toHaveBeenCalledWith({ enabled: true, sampleRateBps: 2500, disclosureVersion: "chat-usage-v1" }, expect.any(AbortSignal)));
});
it("reports sample coverage and partial known measurements without treating unknowns as zero", async () => {
  render(<ChatUsagePanel client={client()} identityKey="owner/runtime" />); await ready();
  expect(screen.getByRole("table", { name: "Chat usage by task family" })).toBeVisible();
  expect(screen.getByText("coding")).toBeVisible();
  expect(screen.getByText(/1 classified.*2 sampled.*4 recorded/)).toBeVisible();
  expect(screen.getAllByText("Unknown").length).toBeGreaterThan(0);
  expect(screen.getByText(/100 known.*1 unknown/)).toBeVisible();
  expect(screen.getByText(/estimates/)).toBeVisible();
});
it("changes grouping and labels a potentially truncated report", async () => {
  const api = client(); render(<ChatUsagePanel client={api} identityKey="owner/runtime" />); await ready();
  api.summary.mockResolvedValue({ ...summary, mayBeTruncated: true, buckets: [{ ...summary.buckets[0], dimensions: { modelId: "actual-model" } }] });
  fireEvent.change(screen.getByLabelText("Group usage by"), { target: { value: "modelId" } });
  await screen.findByText("actual-model");
  expect(api.summary).toHaveBeenLastCalledWith("modelId", expect.any(AbortSignal));
  expect(screen.getByText(/first 100 groups/)).toBeVisible();
});
it("does not relabel stale groups as a successful report after grouping fails", async () => {
  const api = client(); render(<ChatUsagePanel client={api} identityKey="owner/runtime" />); await ready();
  api.summary.mockRejectedValue(new Error("temporary unavailable"));
  fireEvent.change(screen.getByLabelText("Group usage by"), { target: { value: "modelId" } });
  await screen.findByRole("alert");
  expect(screen.queryByRole("table", { name: "Chat usage by model" })).toBeNull();
  expect(screen.queryByText("No recorded generations")).toBeNull();
});
it("stops future work while keeping retained reports", async () => {
  const api = client(); api.policy.mockResolvedValue({ ...policy, enabled: true }); api.configure.mockResolvedValue(policy);
  render(<ChatUsagePanel client={api} identityKey="owner/runtime" />);
  fireEvent.click(await screen.findByRole("button", { name: "Stop Chat usage" }));
  await waitFor(() => expect(api.configure).toHaveBeenCalledWith({ enabled: false, sampleRateBps: 1000 }, expect.any(AbortSignal)));
  expect(api.deleteData).not.toHaveBeenCalled(); expect(screen.getByText("coding")).toBeVisible();
});
it("requires delete confirmation and retains visible facts until the server confirms deletion", async () => {
  const api = client(); let finish!: (value: { deleted: true; enabled: false }) => void;
  api.deleteData.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  render(<ChatUsagePanel client={api} identityKey="owner/runtime" />); await ready();
  fireEvent.click(screen.getByRole("button", { name: "Delete Chat usage data" }));
  expect(api.deleteData).not.toHaveBeenCalled(); expect(screen.getByRole("alertdialog")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Confirm delete" }));
  expect(screen.getByText("coding")).toBeVisible(); finish({ deleted: true, enabled: false });
  await waitFor(() => expect(screen.queryByText("coding")).toBeNull());
  expect(screen.getByText("Chat usage data deleted. Collection is off.")).toBeVisible();
});
it("preserves data and uses generic errors on deletion failure", async () => {
  const api = client(); api.deleteData.mockRejectedValue(new Error("postgres private"));
  render(<ChatUsagePanel client={api} identityKey="owner/runtime" />); await ready();
  fireEvent.click(screen.getByRole("button", { name: "Delete Chat usage data" })); fireEvent.click(screen.getByRole("button", { name: "Confirm delete" }));
  await screen.findByRole("alert"); expect(screen.getByText("coding")).toBeVisible(); expect(screen.queryByText(/postgres/)).toBeNull();
});
it("aborts pending reads on runtime identity change and ignores stale completions", async () => {
  const old = client(); let finish!: (value: ChatUsagePolicy) => void;
  old.policy.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const view = render(<ChatUsagePanel client={old} identityKey="old/runtime" />);
  const oldSignal = old.policy.mock.calls[0]![0] as AbortSignal;
  const next = client(); next.summary.mockResolvedValue({ ...summary, buckets: [] });
  view.rerender(<ChatUsagePanel client={next} identityKey="new/runtime" />);
  expect(oldSignal.aborted).toBe(true); finish({ ...policy, enabled: true });
  await ready(); expect(screen.getByRole("button", { name: "Enable Chat usage" })).toBeDisabled();
  expect(screen.queryByText("coding")).toBeNull();
  view.unmount(); expect((next.policy.mock.calls[0]![0] as AbortSignal).aborted).toBe(true);
});
