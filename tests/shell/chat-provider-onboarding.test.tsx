// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatApp } from "../../shell/src/components/ChatApp";
import { disconnectedSnapshot } from "../ui/chat-provider-settings-fixture";
import { OPEN_PROVIDER_TERMINAL_EVENT } from "../../shell/src/lib/canonical-provider-setup";
import { CanonicalProviderCatalogSchema } from "@matrix-os/contracts";
vi.mock("@clerk/nextjs", async (original) => ({ ...(await original<typeof import("@clerk/nextjs")>()), useOrganization: () => ({ organization: null }) }));
const catalog = CanonicalProviderCatalogSchema.parse({ revision: "empty", drivers: [], instances: [] });
function renderChat() {
  return render(<ChatApp messages={[]} sessionId={undefined} busy={false} connected conversations={[]}
    onNewChat={vi.fn()} onSwitchConversation={vi.fn()} onSubmit={vi.fn()} />);
}
beforeEach(() => { window.localStorage.clear(); vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} }); });
describe("hosted empty Chat connections", () => {
  it("uses Settings login and preserves the composer across connection completion", async () => {
    let snapshot = disconnectedSnapshot();
    const mutations: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).includes("/actions")) {
        mutations.push(JSON.parse(String(init?.body)));
        snapshot = { ...snapshot, revision: 2, projectionOf: { ...snapshot.projectionOf, revision: 2 } };
        return Response.json({ kind: "login_attempt", snapshot, attempt: { id: "attempt_claude", harnessInstanceId: "claude_default", accountId: null, method: "terminal", state: "pending", expiresAt: new Date(Date.now() + 60_000).toISOString(), action: { kind: "open_terminal", terminalSessionId: "claude-login" }, safeFailure: null } });
      }
      return Response.json(String(url).includes("provider-settings") ? snapshot : catalog);
    }));
    const terminal = vi.fn(); window.addEventListener(OPEN_PROVIDER_TERMINAL_EVENT, terminal);
    renderChat();
    const connect = await screen.findByRole("button", { name: "Connect Claude Code" });
    await waitFor(() => expect(connect).toBeEnabled());
    fireEvent.click(connect);
    await waitFor(() => expect(terminal).toHaveBeenCalledOnce());
    expect(mutations[0]).toMatchObject({ type: "start_login", harnessInstanceId: "claude_default", method: "terminal", expectedRevision: 1 });
    expect(await screen.findByRole("button", { name: "Continue in Terminal" })).toBeEnabled();
    const draft = screen.getByPlaceholderText("Write or dictate a draft — connect a harness to send"); fireEvent.change(draft, { target: { value: "Keep my draft" } });
    snapshot = { ...snapshot, harnesses: snapshot.harnesses.map((h) => ({ ...h, authState: "authenticated" as const })) };
    fireEvent(window, new Event("focus"));
    await waitFor(() => expect(screen.queryByText("Connect a coding agent")).not.toBeInTheDocument());
    expect(draft).toHaveValue("Keep my draft");
    window.removeEventListener(OPEN_PROVIDER_TERMINAL_EVENT, terminal);
  });
  it("keeps any disabled connected provider in normal Chat", async () => {
    const snapshot = disconnectedSnapshot(); snapshot.harnesses[0]!.authState = "authenticated";
    vi.stubGlobal("fetch", vi.fn(async (url) => Response.json(String(url).includes("provider-settings") ? snapshot : catalog)));
    renderChat(); expect(await screen.findByText("What should Matrix do?")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Connect Claude Code" })).not.toBeInTheDocument();
  });
  it("refreshes the canonical catalog after manual connection completion", async () => {
    let snapshot = disconnectedSnapshot(); let catalogReads = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes("provider-settings")) return Response.json(snapshot);
      catalogReads += 1; return Response.json(catalog);
    }));
    renderChat(); const check = await screen.findByRole("button", { name: "Check connection" });
    await waitFor(() => expect(check).toBeEnabled()); expect(catalogReads).toBe(1);
    snapshot = { ...snapshot, harnesses: snapshot.harnesses.map((h) => ({ ...h, authState: "authenticated" as const })) };
    fireEvent.click(check);
    await waitFor(() => expect(screen.queryByText("Connect a coding agent")).not.toBeInTheDocument());
    await waitFor(() => expect(catalogReads).toBe(2));
  });
  it("contains failed login mutations and allows an explicit retry without losing the draft", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL) => String(url).includes("/actions")
      ? new Response("private provider error", { status: 503 }) : Response.json(String(url).includes("provider-settings") ? disconnectedSnapshot() : catalog)));
    renderChat();
    const connect = await screen.findByRole("button", { name: "Connect Claude Code" });
    await waitFor(() => expect(connect).toBeEnabled());
    const draft = screen.getByPlaceholderText("Write or dictate a draft — connect a harness to send");
    fireEvent.change(draft, { target: { value: "Retain this prompt" } });
    fireEvent.click(connect);
    expect(await screen.findByRole("alert")).toHaveTextContent("The connection could not be checked or updated");
    expect(screen.queryByText("private provider error")).not.toBeInTheDocument();
    expect(draft).toHaveValue("Retain this prompt");
    const check = screen.getByRole("button", { name: "Check connection" });
    await waitFor(() => expect(check).toBeEnabled()); fireEvent.click(check);
    await waitFor(() => expect(screen.getByRole("button", { name: "Connect Claude Code" })).toBeEnabled());
  });
  it("shows safe retry after a settings failure without replacing the editable draft", async () => {
    let failed = true;
    vi.stubGlobal("fetch", vi.fn(async (url) => String(url).includes("provider-settings") ? failed ? new Response("unavailable", { status: 503 }) : Response.json(disconnectedSnapshot()) : Response.json(catalog)));
    renderChat(); expect(await screen.findByText("Connection status unavailable")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Connect Claude Code" })).not.toBeInTheDocument();
    failed = false; fireEvent.click(screen.getByRole("button", { name: "Check connection" }));
    expect(await screen.findByRole("button", { name: "Connect Codex" })).toBeEnabled();
  });
});
