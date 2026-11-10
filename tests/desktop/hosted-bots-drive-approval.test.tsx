// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopBotsWorkspace, DesktopHostedBotsProvider } from "@renderer/features/bots/DesktopBotsWorkspace";
import type { ApiClient, JsonRequestOptions } from "@renderer/lib/api";
import { useTabs } from "@renderer/stores/tabs";
import { useUi } from "@renderer/stores/ui";

vi.mock("@renderer/features/embeds/EmbedHost", () => ({ default: () => <main>Hosted Bots conversation</main> }));

const PATH = "/api/hosted-bots/drive";
const ID = "c550fd7e-1933-4744-a1f9-9cb667af33c1";
const FILE = "fixture_document_123";
const ACCOUNT = { id: "work-connection", label: "Work account" };

function setup(accounts = [ACCOUNT], initialStatus: "pending" | "reading" = "pending") {
  let status: "pending" | "reading" | "finished" = initialStatus;
  const get = vi.fn(async (path: string, _options?: JsonRequestOptions) => ({
    requests: status === "finished" ? [] : [{ id: ID, fileId: FILE, expiresAt: Date.now() + 60_000, status }],
    accounts: path === `${PATH}?includeAccounts=1` ? accounts : [],
  }));
  const post = vi.fn(async (_path: string, body: { decision: string }) => {
    status = body.decision === "allow" ? "reading" : "finished";
    return { ok: true };
  });
  const remove = vi.fn(async () => {
    status = "finished";
    return { ok: true };
  });
  const transport = { get, post, delete: remove } as unknown as ApiClient;
  const workspace = (visible: boolean, active = visible) => (
    <DesktopHostedBotsProvider value={{ mode: "oss", transport, scope: "private-preview-owner" }}>
      <DesktopBotsWorkspace visible={visible} active={active} />
    </DesktopHostedBotsProvider>
  );
  return { get, post, remove, workspace };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useTabs.setState(useTabs.getInitialState(), true);
  useUi.setState(useUi.getInitialState(), true);
});

describe("Hosted Bots Drive approvals", () => {
  it("keeps the exact document and account in Matrix before granting a one-time read", async () => {
    const { get, post, remove, workspace } = setup();
    render(workspace(true));
    expect(screen.getByText("Hosted Bots conversation")).toBeTruthy();
    const review = await screen.findByRole("button", { name: "Review Drive request" });
    expect(get.mock.calls.map(([path]) => path)).toEqual([PATH]);
    expect(post).not.toHaveBeenCalled();
    fireEvent.click(review);
    expect(await screen.findByText(FILE)).toBeTruthy();
    const account = await screen.findByRole("combobox", { name: "Google Drive account" });
    const approve = screen.getByRole<HTMLButtonElement>("button", { name: "Allow once" });
    expect(approve.disabled).toBe(true);
    fireEvent.change(account, { target: { value: ACCOUNT.id } });
    fireEvent.click(approve);
    await waitFor(() => expect(post).toHaveBeenCalledWith(`${PATH}/${ID}/decision`, {
      decision: "allow",
      accountId: ACCOUNT.id,
    }, expect.any(Object)));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel read" }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith(`${PATH}/${ID}`, undefined, expect.any(Object)));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Cancel read" })).toBeNull());
  });

  it("directs the owner to Matrix Connect Apps when no Drive account is available and can still deny", async () => {
    const { post, workspace } = setup([]);
    render(workspace(true));
    fireEvent.click(await screen.findByRole("button", { name: "Review Drive request" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open Connect Apps" }));
    expect(useUi.getState().requestedSettingsSection).toBe("services");
    expect(useTabs.getState().tabs).toContainEqual(expect.objectContaining({ kind: "settings", title: "Connect Apps" }));
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    await waitFor(() => expect(post).toHaveBeenCalledWith(`${PATH}/${ID}/decision`, { decision: "deny" }, expect.any(Object)));
    await waitFor(() => expect(screen.queryByText(FILE)).toBeNull());
  });

  it("never polls while the Bots view is inactive and cancels its poll when hidden", async () => {
    vi.useFakeTimers();
    const { get, workspace } = setup();
    const { rerender } = render(workspace(true, false));
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(get).not.toHaveBeenCalled();
    rerender(workspace(true));
    await act(async () => {});
    expect(get).toHaveBeenCalledTimes(1);
    rerender(workspace(false));
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(get).toHaveBeenCalledTimes(1);
    expect(get.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(screen.queryByRole("button", { name: "Review Drive request" })).toBeNull();
  });
});
