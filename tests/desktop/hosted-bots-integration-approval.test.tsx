// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopBotsWorkspace, DesktopHostedBotsProvider } from "@renderer/features/bots/DesktopBotsWorkspace";
import { AppError } from "../../desktop/src/shared/app-error";
import type { ApiClient, JsonRequestOptions } from "@renderer/lib/api";
import { useTabs } from "@renderer/stores/tabs";
import { useUi } from "@renderer/stores/ui";

vi.mock("@renderer/features/embeds/EmbedHost", () => ({ default: () => <main>Hosted Bots conversation</main> }));

const PATH = "/api/hosted-bots/integrations";
const LEGACY_PATH = "/api/hosted-bots/drive";
const ID = "c550fd7e-1933-4744-a1f9-9cb667af33c1";
const FILE = "fixture_document_123";
const ACCOUNT = { id: "work-connection", label: "Work account", service: "google_drive" };
const GITHUB_ACCOUNT = { id: "github-developer:octocat", label: "GitHub Developer · octocat", service: "github" };
const PIPEDREAM_GITHUB_ACCOUNT = { id: "github-connection", label: "GitHub work account", service: "github" };
const DRIVE = { service: "google_drive", action: "read_file", params: { fileId: FILE } };
const GITHUB = { service: "github", action: "list_prs", params: { repo: "HamedMP/matrix-os", per_page: 1 } };

function setup(accounts = [ACCOUNT], request: { service: string; action: string; params: Record<string, string | number> } = DRIVE, legacy = false) {
  let status: "pending" | "reading" | "finished" = "pending";
  const expiresAt = Date.now() + 60_000;
  const get = vi.fn(async (path: string, _options?: JsonRequestOptions) => {
    if (legacy && path === PATH) throw new AppError("notFound", { httpStatus: 404 });
    return {
      requests: status === "finished" ? [] : [{ id: ID, ...(legacy ? { fileId: FILE } : request), expiresAt, status }],
      accounts: path.endsWith("?includeAccounts=1")
        ? accounts.map(({ id, label, service }) => legacy ? { id, label } : { id, label, service })
        : [],
    };
  });
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

describe("Hosted Bots integration approvals", () => {
  it("displays the exact GitHub action and parameters and offers the GitHub Developer account", async () => {
    const { get, post, workspace } = setup([ACCOUNT, PIPEDREAM_GITHUB_ACCOUNT, GITHUB_ACCOUNT], GITHUB);
    render(workspace(true));
    fireEvent.click(await screen.findByRole("button", { name: "Review GitHub Developer request" }));
    expect(get.mock.calls.map(([path]) => path)).toEqual([PATH, `${PATH}?includeAccounts=1`]);
    expect(screen.getByText("list_prs")).toBeTruthy();
    expect(screen.getByText(/"repo": "HamedMP\/matrix-os"/).textContent).toContain('"per_page": 1');
    expect(screen.getByText(/results will be shared with the requesting conversation/i)).toBeTruthy();
    const account = await screen.findByRole("combobox", { name: "GitHub Developer account" });
    expect(screen.getByRole("option", { name: "GitHub Developer · octocat" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "Work account" })).toBeNull();
    expect(screen.queryByRole("option", { name: "GitHub work account" })).toBeNull();
    const approve = screen.getByRole<HTMLButtonElement>("button", { name: "Allow once" });
    expect(approve.disabled).toBe(true);
    fireEvent.change(account, { target: { value: GITHUB_ACCOUNT.id } });
    fireEvent.click(approve);
    await waitFor(() => expect(post).toHaveBeenCalledWith(`${PATH}/${ID}/decision`, {
      decision: "allow",
      accountId: GITHUB_ACCOUNT.id,
    }, expect.any(Object)));
  });

  it("directs the owner to GitHub Developer when that connection is missing", async () => {
    const { post, workspace } = setup([PIPEDREAM_GITHUB_ACCOUNT], GITHUB);
    render(workspace(true));
    fireEvent.click(await screen.findByRole("button", { name: "Review GitHub Developer request" }));
    expect(await screen.findByText("Connect GitHub Developer in Connect Apps to approve this read.")).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Allow once" }).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Open Connect Apps" }));
    expect(useUi.getState().requestedSettingsSection).toBe("services");
    expect(post).not.toHaveBeenCalled();
  });

  it("requires a new review if the request parameters change before loading the account picker", async () => {
    const { get, post, workspace } = setup([GITHUB_ACCOUNT], GITHUB);
    render(workspace(true));
    const review = await screen.findByRole("button", { name: "Review GitHub Developer request" });
    const advertised = await get.mock.results[0]!.value;
    get.mockResolvedValueOnce({
      requests: advertised.requests.map((request) => ({ ...request, params: { repo: "other/repo", per_page: 1 } })),
      accounts: [GITHUB_ACCOUNT],
    });
    fireEvent.click(review);
    await waitFor(() => expect(screen.queryByText("GitHub Developer read requested")).toBeNull());
    expect(screen.queryByRole("button", { name: "Allow once" })).toBeNull();
    expect(post).not.toHaveBeenCalled();
  });

  it("preserves Drive approvals on a Preview with only the legacy route", async () => {
    const { get, post, workspace } = setup([ACCOUNT], DRIVE, true);
    render(workspace(true));
    fireEvent.click(await screen.findByRole("button", { name: "Review Drive request" }));
    expect(get.mock.calls.map(([path]) => path)).toEqual([PATH, LEGACY_PATH, `${LEGACY_PATH}?includeAccounts=1`]);
    const account = await screen.findByRole("combobox", { name: "Google Drive account" });
    fireEvent.change(account, { target: { value: ACCOUNT.id } });
    fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
    await waitFor(() => expect(post).toHaveBeenCalledWith(`${LEGACY_PATH}/${ID}/decision`, {
      decision: "allow",
      accountId: ACCOUNT.id,
    }, expect.any(Object)));
  });
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
