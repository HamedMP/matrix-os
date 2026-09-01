// @vitest-environment jsdom

import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ChatTab from "../../desktop/src/renderer/src/features/chat/ChatTab";
import { createLegacyGlobalProviderCatalog } from "../../desktop/src/renderer/src/features/chat/canonical-composer-adapter";
import { useProviderPreferences } from "../../desktop/src/renderer/src/features/settings/provider-preferences";
import { useDesktopEditor } from "../../desktop/src/renderer/src/features/editor/desktop-editor-store";
import {
  conversationMessageDisplay,
  sharedConversationResources,
} from "../../desktop/src/renderer/src/features/chat/ChatResourcesPanel";
import { useBoard } from "../../desktop/src/renderer/src/stores/board";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";
import { useCodingAgentWorkspace } from "../../desktop/src/renderer/src/stores/coding-agent-workspace";
import { useHermesChat } from "../../desktop/src/renderer/src/stores/hermes-chat";
import { useTabs } from "../../desktop/src/renderer/src/stores/tabs";
import { useThreads, type AgentThread } from "../../desktop/src/renderer/src/stores/threads";
import { appendSharedComposerText, setSharedComposerText } from "./shared-chat-composer-test-utils";

function thread(id: string, title: string): AgentThread {
  return {
    id,
    requestId: `request-${id}`,
    sessionId: null,
    taskId: null,
    title,
    status: "running",
    transcript: [],
    unread: false,
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("ChatTab", () => {
  beforeEach(() => {
    class MockResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    globalThis.ResizeObserver = MockResizeObserver as typeof ResizeObserver;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn(async () => undefined) },
    });
    useBoard.setState({
      projects: [{ slug: "matrix-os", name: "Matrix OS" }],
    });
    useHermesChat.setState({
      messages: [{ id: "m1", role: "user", content: "hello", timestamp: 1 }],
      status: "idle",
      view: "conversation",
      conversations: [],
      indexStatus: "ready",
      indexError: null,
      loadStatus: "idle",
      loadError: null,
      loadingConversationId: null,
      send: vi.fn(() => true),
      abort: vi.fn(),
    });
    useThreads.setState({ threads: [], activeThreadId: null });
    useCodingAgentWorkspace.setState(useCodingAgentWorkspace.getInitialState(), true);
    useCodingAgentWorkspace.setState({
      summary: { providers: [] } as never,
      status: "ready",
    });
    useTabs.setState(useTabs.getInitialState(), true);
    useDesktopEditor.setState(useDesktopEditor.getInitialState(), true);
    useProviderPreferences.setState({
      defaultProviderId: null,
      lastComposerInstanceId: null,
      composerSelections: {},
      hydrated: true,
    });
    useConnection.setState({
      status: "signed-in",
      handle: "operator",
      platformHost: "https://platform.test",
      runtimeSlot: "primary",
      authGeneration: 1,
      api: null,
    });
    Object.defineProperty(window, "operator", {
      configurable: true,
      value: {
        invoke: vi.fn(async (channel: string) => {
          if (channel === "state:get") return { value: null };
          if (channel === "state:set") return { ok: true };
          throw new Error(`unexpected channel ${channel}`);
        }),
        on: vi.fn(() => () => undefined),
      },
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("does not render the full-height empty-state spacer when messages exist", () => {
    const { container } = render(<ChatTab />);

    expect(container.textContent).toContain("hello");
    expect(container.querySelector(".h-full.items-center.justify-center")).toBeNull();
    expect(container.querySelector('[data-slot="message-scroller-content"]')?.className)
      .toContain("justify-start");
    expect(container.querySelector('[data-slot="message-scroller-content"]')?.className)
      .not.toContain("30vh");
  });

  it("keeps a canonical connection error inside the current Chat surface", async () => {
    useHermesChat.setState({ view: "index", indexStatus: "ready", conversations: [] });
    useConnection.setState({
      api: {
        baseUrl: "https://matrix.test",
        get: vi.fn(async () => { throw new Error("offline"); }),
      } as never,
    });

    render(<ChatTab allowLegacyFallback={false} />);

    expect((await screen.findByRole("alert")).textContent).toContain("Chat unavailable");
    expect(screen.getByRole("button", { name: "Retry Chat" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Chats" })).toBeNull();
    expect(screen.queryByText("Start a chat with Hermes, then return to it from any shell.")).toBeNull();
  });

  it("collapses completed work behind the receipt while keeping the final response visible", () => {
    useHermesChat.setState({
      status: "idle",
      messages: [
        { id: "user-1", role: "user", content: "Inspect the repo", requestId: "request-1", timestamp: 1_000 },
        { id: "assistant-1", role: "assistant", content: "I’ll inspect it.", requestId: "request-1", timestamp: 2_000 },
        { id: "tool-1", role: "system", content: "Used ToolSearch", tool: "ToolSearch", requestId: "request-1", toolInput: { query: "repository tools" }, timestamp: 3_000 },
        { id: "tool-2", role: "system", content: "Used Read", tool: "Read", requestId: "request-1", toolDisplay: { kind: "file", preview: "README.md" }, timestamp: 6_000 },
        { id: "tool-3", role: "system", content: "Used Bash", tool: "Bash", requestId: "request-1", toolDisplay: { kind: "command", preview: "git status --short" }, timestamp: 8_000 },
        { id: "assistant-2", role: "assistant", content: "The repository is clean.", requestId: "request-1", timestamp: 13_000 },
      ],
    });

    render(<ChatTab />);

    const receipt = screen.getByRole("button", { name: "Worked for 12s" });
    expect(receipt.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("I’ll inspect it.")).toBeNull();
    expect(screen.queryByRole("button", { name: "2 previous activities" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Ran command: git status --short" })).toBeNull();
    expect(screen.getByText("The repository is clean.")).toBeTruthy();

    fireEvent.click(receipt);
    expect(receipt.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("I’ll inspect it.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Ran command: git status --short" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "2 previous activities" }));
    expect(screen.getByRole("button", { name: "Searched tools: repository tools" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Read file: README.md" })).toBeTruthy();

    fireEvent.click(receipt);
    expect(screen.queryByText("I’ll inspect it.")).toBeNull();
    expect(screen.queryByRole("button", { name: "Ran command: git status --short" })).toBeNull();
    expect(screen.getByText("The repository is clean.")).toBeTruthy();
  });

  it("renders T3-style path chips and hover metadata on the final assistant response", async () => {
    const completedAt = new Date("2026-08-22T00:05:00.000+08:00").getTime();
    const response = "- `pwd`: `/home/matrix/home/matrixos`\n- `uname -s`: `Darwin`";
    useHermesChat.setState({
      status: "idle",
      messages: [
        { id: "user-polish", role: "user", content: "Inspect this computer", requestId: "request-polish", timestamp: completedAt - 23_000 },
        { id: "assistant-polish", role: "assistant", content: response, requestId: "request-polish", timestamp: completedAt },
      ],
    });

    render(<ChatTab />);

    const folderChip = screen.getByLabelText("Folder path: matrixos");
    expect(folderChip.getAttribute("title")).toBe("/home/matrix/home/matrixos");
    expect(screen.getByText("pwd").className).toContain("border");
    expect(screen.getByLabelText(`Assistant message sent at ${new Date(completedAt).toISOString()}`)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Copy assistant message" }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith(response));
    expect(screen.getByRole("button", { name: "Copied assistant message" })).toBeTruthy();
  });

  it("offers the same hover copy and timestamp affordances on user input", async () => {
    const sentAt = new Date("2026-08-22T00:04:37.000+08:00").getTime();
    useHermesChat.setState({
      status: "idle",
      messages: [{ id: "user-meta", role: "user", content: "Show the current folder", timestamp: sentAt }],
    });

    render(<ChatTab />);

    expect(screen.getByLabelText(`User message sent at ${new Date(sentAt).toISOString()}`)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Copy user message" }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith("Show the current folder"));
    expect(screen.getByRole("button", { name: "Copied user message" })).toBeTruthy();
  });

  it("renders fenced commands as bounded code cards with copy feedback", async () => {
    const response = "```sh\npwd && git status --short\n```";
    useHermesChat.setState({
      status: "idle",
      messages: [{ id: "assistant-code", role: "assistant", content: response, timestamp: 10_000 }],
    });

    render(<ChatTab />);

    expect(screen.getByText("sh")).toBeTruthy();
    const pre = screen.getByText("pwd && git status --short").closest("pre");
    expect(pre?.className).toContain("overflow-x-auto");
    fireEvent.click(screen.getByRole("button", { name: "Wrap code block" }));
    expect(pre?.className).toContain("whitespace-pre-wrap");
    expect(screen.getByRole("button", { name: "Disable code wrapping" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Copy code block" }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith("pwd && git status --short"));
    expect(screen.getByRole("button", { name: "Copied code block" })).toBeTruthy();
  });

  it("keeps structured agent output readable and copyable with GFM tables", async () => {
    useHermesChat.setState({
      status: "idle",
      messages: [{
        id: "assistant-table",
        role: "assistant",
        content: "| File | Status |\n| --- | --- |\n| README.md | clean |",
        timestamp: 10_000,
      }],
    });

    render(<ChatTab />);

    const table = screen.getByRole("table");
    expect(table.className).toContain("border-collapse");
    expect(screen.getByRole("columnheader", { name: "File" })).toBeTruthy();
    expect(screen.getByRole("cell", { name: "README.md" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Copy table as Markdown" }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      "| File | Status |\n| --- | --- |\n| README.md | clean |",
    ));
    expect(screen.getByRole("button", { name: "Copied table as Markdown" })).toBeTruthy();
  });

  it("renders safe external links and native GFM task state", () => {
    useHermesChat.setState({
      status: "idle",
      messages: [{
        id: "assistant-rich-markdown",
        role: "assistant",
        content: "- [x] Checked\n\n[Matrix](https://matrix-os.com)",
        timestamp: 10_000,
      }],
    });

    render(<ChatTab />);

    const task = screen.getByRole("checkbox", { name: "Completed task" }) as HTMLInputElement;
    expect(task.checked).toBe(true);
    expect(task.disabled).toBe(true);
    expect(task.hasAttribute("node")).toBe(false);
    const link = screen.getByRole("link", { name: "Matrix" });
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(link.hasAttribute("node")).toBe(false);
  });

  it("opens full Matrix-home file paths from Chat in a new Editor tab", () => {
    useHermesChat.setState({
      status: "idle",
      messages: [{
        id: "assistant-file-path",
        role: "assistant",
        content: "Open `/home/matrix/home/projects/app/src/main.ts:42` to inspect the change.",
        timestamp: 10_000,
      }],
    });

    render(<ChatTab />);
    fireEvent.click(screen.getByRole("button", { name: "Open main.ts in Editor" }));

    expect(useDesktopEditor.getState()).toMatchObject({
      paths: ["projects/app/src/main.ts"],
      activePath: "projects/app/src/main.ts",
    });
    expect(useTabs.getState().tabs).toContainEqual(expect.objectContaining({
      kind: "editor",
      title: "Editor",
    }));
  });

  it("shows live turn and tool status without claiming unavailable reasoning", () => {
    useHermesChat.setState({
      status: "streaming",
      activeRequestId: "request-live",
      messages: [
        { id: "user-live", role: "user", content: "Run the checks", requestId: "request-live", timestamp: Date.now() - 2_000 },
        { id: "assistant-live", role: "assistant", content: "I’ll run the checks.", requestId: "request-live", timestamp: Date.now() - 1_500 },
        { id: "tool-live", role: "system", content: "Using Bash...", tool: "Bash", requestId: "request-live", toolInput: { command: "bun run test" }, timestamp: Date.now() - 1_000 },
      ],
    });

    render(<ChatTab />);

    expect(screen.getByText(/^Working for \d+s$/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Running command: bun run test" })).toBeTruthy();
    const commandChip = screen.getByText("bun run test");
    expect(commandChip.className).toContain("border");
    expect(commandChip.getAttribute("title")).toBe("bun run test");
    expect(screen.queryByRole("button", { name: "Copy assistant message" })).toBeNull();
    expect(screen.queryByText("Thought process")).toBeNull();
  });

  it("renders failed command work as failed instead of running or complete", () => {
    useHermesChat.setState({
      status: "idle",
      messages: [
        { id: "user-failed", role: "user", content: "Run the checks", requestId: "request-failed", timestamp: 1_000 },
        {
          id: "tool-failed",
          role: "system",
          content: "Failed Bash",
          tool: "Bash",
          requestId: "request-failed",
          toolDisplay: { kind: "command", preview: "bun run test" },
          timestamp: 2_000,
        },
        { id: "error-failed", role: "system", content: "The command failed.", requestId: "request-failed", timestamp: 3_000 },
      ],
    });

    render(<ChatTab />);

    fireEvent.click(screen.getByRole("button", { name: "Worked for 2s" }));
    expect(screen.getByRole("button", { name: "Failed command: bun run test" })).toBeTruthy();
    const failureNotice = screen.getByRole("status", { name: "Agent work failed" });
    expect(failureNotice.textContent).toContain("Agent work failed");
    expect(failureNotice.textContent).toContain("The command failed.");
    expect(failureNotice.className).toContain("rounded-xl");
    expect(failureNotice.className).toContain("border");
    expect(failureNotice.className).toContain("px-3");
    expect(failureNotice.style.background).toBe("");
    expect(failureNotice.style.borderColor).toBe("var(--danger)");
    expect(screen.queryByRole("button", { name: "Running command: bun run test" })).toBeNull();
  });

  it("copies a command from its work row and redacts credential-shaped values", async () => {
    useHermesChat.setState({
      status: "streaming",
      activeRequestId: "request-command-copy",
      messages: [
        { id: "user-command-copy", role: "user", content: "Inspect safely", requestId: "request-command-copy", timestamp: 1_000 },
        {
          id: "tool-command-copy",
          role: "system",
          content: "Using Bash...",
          tool: "Bash",
          requestId: "request-command-copy",
          toolInput: {
            command: "curl -H 'X-Api-Key: \"header-secret\"' API_KEY=supersecret https://example.com",
            unrelated: "do-not-render",
          },
          timestamp: 2_000,
        },
      ],
    });

    render(<ChatTab />);

    expect(screen.queryByText(/supersecret/)).toBeNull();
    expect(screen.queryByText(/header-secret/)).toBeNull();
    expect(screen.queryByText(/do-not-render/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Copy command" }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      "curl -H 'X-Api-Key: [redacted]' API_KEY=[redacted] https://example.com",
    ));
    expect(screen.getByRole("button", { name: "Copied command" })).toBeTruthy();
  });

  it.each([
    ["cookie request header", "curl -H 'Cookie: sessionid=cookie-secret; csrf=csrf-secret' https://example.com", "curl -H 'Cookie: [redacted]' https://example.com", "cookie-secret"],
    ["cookie response header", "curl -H 'Set-Cookie: sessionid=response-cookie-secret' https://example.com", "curl -H 'Set-Cookie: [redacted]' https://example.com", "response-cookie-secret"],
    ["short basic auth flag", "curl -u alice:short-secret https://example.com", "curl -u [redacted] https://example.com", "short-secret"],
    ["long basic auth flag", "curl --user bob:long-secret https://example.com", "curl --user [redacted] https://example.com", "long-secret"],
    ["equals basic auth flag", "curl --user='carol:quoted-secret' https://example.com", "curl --user=[redacted] https://example.com", "quoted-secret"],
    ["quoted Authorization scheme and credential", "curl -H 'Authorization: \"Bearer outer-scheme-secret\"' https://example.com", "curl -H 'Authorization: [redacted]' https://example.com", "outer-scheme-secret"],
    ["quoted Authorization credential", "curl -H 'Authorization: Bearer \"quoted-value-secret\"' https://example.com", "curl -H 'Authorization: [redacted]' https://example.com", "quoted-value-secret"],
    ["quoted Proxy-Authorization value", "curl -H \"Proxy-Authorization: 'Basic proxy-secret'\" https://example.com", "curl -H \"Proxy-Authorization: [redacted]\" https://example.com", "proxy-secret"],
    ["quoted raw Authorization credential", "curl -H 'Authorization: \"raw-credential-secret\"' https://example.com", "curl -H 'Authorization: [redacted]' https://example.com", "raw-credential-secret"],
    ["non-HTTP URL userinfo", "psql postgres://alice:database-url-secret@db.example.com/app", "psql postgres://[redacted]@db.example.com/app", "database-url-secret"],
  ])("redacts %s from command display and clipboard", async (_case, command, expected, secret) => {
    useHermesChat.setState({
      status: "streaming",
      activeRequestId: "request-command-redaction",
      messages: [
        { id: "user-command-redaction", role: "user", content: "Inspect safely", requestId: "request-command-redaction", timestamp: 1_000 },
        {
          id: "tool-command-redaction",
          role: "system",
          content: "Using Bash...",
          tool: "Bash",
          requestId: "request-command-redaction",
          toolInput: { command },
          timestamp: 2_000,
        },
      ],
    });

    render(<ChatTab />);

    expect(screen.queryByText(new RegExp(secret))).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Copy command" }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expected));
  });

  it("renders the approved centered empty state and only working composer controls", () => {
    useHermesChat.setState({ messages: [], status: "idle", send: vi.fn(() => true), abort: vi.fn() });
    render(<ChatTab />);

    expect(screen.getByRole("heading", { name: "What should we build today?" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "How can I help you today?" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Attach files" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Choose project for chat" }).closest(".prompt-card"))
      .not.toBeNull();
    expect(screen.queryByRole("button", { name: "Resources" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Use Codex for a project chat" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add to project" })).toBeNull();
    expect(screen.getByRole("button", { name: "Explore and understand code" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Build a new feature, app, or tool" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Review code and suggest changes" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Fix issues and failures" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Choose model and provider" }).getAttribute("data-provider-instance"))
      .toBe("hermes_default");
    expect(screen.queryByTestId("chat-empty-logo")).toBeNull();
    expect(screen.getByTestId("chat-empty-content").className).toContain("justify-center");
    expect(screen.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(true);
    expect(screen.queryByText("Connect messaging")).toBeNull();
    expect(screen.queryByRole("button", { name: /voice|microphone/i })).toBeNull();
  });

  it("seeds the shared composer from a Figma starter card", async () => {
    useHermesChat.setState({ messages: [], status: "idle", send: vi.fn(() => true), abort: vi.fn() });
    render(<ChatTab />);

    fireEvent.click(screen.getByRole("button", { name: "Review code and suggest changes" }));

    await waitFor(() => expect(
      screen.getByRole("textbox", { name: "How can I help you today?" }).textContent,
    ).toBe("Review code and suggest changes"));
  });

  it("removes the redundant internal Chat rail and leaves agent-run navigation to global Recents", () => {
    useThreads.setState({
      threads: [thread("t1", "Build parser")],
      activeThreadId: null,
    });

    render(<ChatTab />);

    expect(screen.queryByRole("button", { name: "Build parser" })).toBeNull();
    expect(screen.queryByText("Agent runs")).toBeNull();
    expect(screen.queryByRole("button", { name: "Conversations" })).toBeNull();
    expect(screen.getByText("hello")).toBeTruthy();
  });

  it("adds files from the visible attachment control", async () => {
    useHermesChat.setState({ messages: [], status: "idle", send: vi.fn(() => true), abort: vi.fn() });
    render(<ChatTab />);

    const picker = screen.getByLabelText("Choose files") as HTMLInputElement;
    const file = new File(["notes"], "notes.md", { type: "text/markdown" });
    fireEvent.change(picker, { target: { files: [file] } });

    expect(await screen.findByRole("button", { name: "Remove notes.md" })).toBeTruthy();
  });

  it("reduces canonical resource paths to bounded basenames", () => {
    expect(sharedConversationResources([{
      id: "m1",
      role: "user",
      content: "Attached files (available on your Matrix computer):\n- ~/temporary/desktop-chat/abc-folder/secrets.txt (/home/matrix/home/temporary/desktop-chat/abc-folder/secrets.txt)",
      timestamp: 1,
    }])).toEqual(["secrets.txt"]);
  });

  it("keeps spaced attachment names readable without exposing transport paths", () => {
    useHermesChat.setState({
      messages: [{
        id: "m1",
        role: "user",
        content: "Review the final draft\n\nAttached files (available on your Matrix computer):\n- ~/temporary/desktop-chat/abc-final report.pdf (/home/matrix/home/temporary/desktop-chat/abc-final report.pdf)",
        timestamp: 1,
      }],
    });

    render(<ChatTab />);

    expect(screen.getByText("Review the final draft")).toBeTruthy();
    expect(screen.getByText("final report.pdf")).toBeTruthy();
    expect(document.body.textContent).not.toContain("temporary/desktop-chat");
    expect(document.body.textContent).not.toContain("/home/matrix");

  });

  it("reports malformed attachment-name encoding before using a safe fallback", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(conversationMessageDisplay(
      "Review this\n\nAttached files (available on your Matrix computer):\n"
      + "- ~/temporary/desktop-chat/abc-report%ZZ.pdf "
      + "(/home/matrix/home/temporary/desktop-chat/abc-report%ZZ.pdf)",
    )).toEqual({ text: "Review this", attachments: ["report%ZZ.pdf"] });
    expect(warn).toHaveBeenCalledWith(
      "[chat-resources] attachment name decode failed:",
      "URIError",
    );
  });

  it("previews pasted files horizontally, uploads on Send, and sends Hermes readable paths", async () => {
    const send = vi.fn(() => true);
    const putBytes = vi.fn(async (path: string, file: File) => ({
      ok: true,
      path: decodeURIComponent(path.split("path=")[1] ?? ""),
      size: file.size,
    }));
    useHermesChat.setState({ messages: [], status: "idle", send, abort: vi.fn() });
    useConnection.setState({ api: { putBytes } as never });
    render(<React.StrictMode><ChatTab /></React.StrictMode>);

    const pane = screen.getByRole("region", { name: "Hermes conversation" });
    const pasted = new File(["screen"], "screen.png", { type: "image/png" });
    fireEvent.paste(pane, { clipboardData: { files: [pasted] } });

    expect(await screen.findByRole("button", { name: "Remove screen.png" })).toBeTruthy();
    const previewRow = screen.getByRole("group", { name: "Attachments" });
    expect(previewRow.className).toContain("overflow-x-auto");
    const input = screen.getByLabelText("How can I help you today?");
    await setSharedComposerText(input, "Review this screenshot");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(putBytes).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(send).toHaveBeenCalledWith(expect.stringMatching(
      /^Review this screenshot\n\nAttached files[\s\S]*~\/temporary\/desktop-chat\/[A-Za-z0-9]+-screen\.png \(\/home\/matrix\/home\/temporary\/desktop-chat\/[A-Za-z0-9]+-screen\.png\)$/,
    )));
    expect(screen.queryByRole("button", { name: "Remove screen.png" })).toBeNull();
  });

  it("promotes a Hermes conversation only after the user sends a message", async () => {
    const send = vi.fn(() => true);
    useHermesChat.setState({
      messages: [],
      sessionId: "conversation-active",
      status: "idle",
      send,
      abort: vi.fn(),
    });
    render(<ChatTab />);

    await setSharedComposerText(
      screen.getByRole("textbox", { name: "How can I help you today?" }),
      "Continue the release check",
    );
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(send).toHaveBeenCalledWith("Continue the release check"));
  });

  it("sends Global Chat skill and project tokens as agent-readable prompt context", async () => {
    const send = vi.fn(() => true);
    const catalog = createLegacyGlobalProviderCatalog({ hasProject: true });
    const availableCatalog = {
      ...catalog,
      instances: catalog.instances.map((instance) => ({
        ...instance,
        availability: "available" as const,
        models: instance.models.map((model) => ({ ...model, availability: "available" as const })),
        skills: instance.id === "hermes_default"
          ? [{ id: "review", displayName: "Review", description: "Review the selected context", invocation: "/review" }]
          : instance.skills,
        defaultSelection: { instanceId: instance.id, model: instance.models[0]!.id, options: [] },
      })),
    };
    useConnection.setState({
      api: {
        get: vi.fn(async (path: string) => {
          if (path.startsWith("/api/chat-providers")) return availableCatalog;
          if (path.startsWith("/api/files/list")) return { entries: [] };
          throw new Error(`unexpected GET ${path}`);
        }),
      } as never,
    });
    useHermesChat.setState({ messages: [], status: "idle", send, abort: vi.fn() });
    render(<ChatTab />);

    const input = screen.getByLabelText("How can I help you today?");
    await setSharedComposerText(input, "/rev");
    fireEvent.click(await screen.findByRole("option", { name: /Review/ }));
    await appendSharedComposerText(input, "Inspect @Matrix");
    fireEvent.click(await screen.findByRole("option", { name: /Matrix OS/ }));

    expect(screen.getByTestId("composer-reference-token-skill-review")).toBeTruthy();
    expect(await screen.findByTestId("composer-reference-token-project-matrix-os")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(send).toHaveBeenCalledWith(
      "/review Inspect [Matrix OS](matrix-os)",
    ));
  });

  it("keeps non-Hermes harnesses visible but unavailable on the legacy Global route", async () => {
    const catalog = createLegacyGlobalProviderCatalog({ hasProject: true });
    const availableCatalog = {
      ...catalog,
      instances: catalog.instances.map((instance) => ({
        ...instance,
        availability: "available" as const,
        models: instance.models.map((model) => ({ ...model, availability: "available" as const })),
        defaultSelection: { instanceId: instance.id, model: instance.models[0]!.id, options: [] },
      })),
    };
    useConnection.setState({
      api: {
        get: vi.fn(async (path: string) => {
          if (path.startsWith("/api/chat-providers")) return availableCatalog;
          throw new Error(`unexpected GET ${path}`);
        }),
      } as never,
    });
    useHermesChat.setState({ messages: [], status: "idle" });
    render(<ChatTab />);

    fireEvent.click(screen.getByRole("button", { name: "Choose model and provider" }));
    const codex = await screen.findByRole("button", { name: "Codex harness, Unavailable" });
    expect(codex.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByRole("button", { name: "Choose model and provider" }).textContent)
      .toContain("Current model");
    expect(useTabs.getState().tabs).not.toContainEqual(expect.objectContaining({ kind: "project" }));
  });

  it("opens authenticated provider setup from the Global Chat catalog", async () => {
    const fallback = createLegacyGlobalProviderCatalog({ hasProject: true });
    const connectAction = {
      id: "claude_connect",
      kind: "foreground_terminal" as const,
      label: "Connect Claude",
      command: "claude",
    };
    const catalog = {
      ...fallback,
      drivers: [
        ...fallback.drivers,
        { kind: "claude_code" as const, displayName: "Claude Code", adapterVersion: "1.0.0", capabilityClass: "coding_agent" as const },
      ],
      instances: [
        ...fallback.instances,
        {
          ...fallback.instances[1]!,
          id: "claude_code_default",
          driverKind: "claude_code" as const,
          displayName: "Claude Code",
          availability: "auth_required" as const,
          models: [{
            ...fallback.instances[1]!.models[0]!,
            availability: "auth_required" as const,
          }],
          setupActions: [connectAction],
        },
      ],
    };
    const provider = {
      id: "claude",
      kind: "claude" as const,
      displayName: "Claude",
      availability: "auth_required" as const,
      installStatus: "installed" as const,
      authStatus: "missing" as const,
      supportedModes: ["default"],
      defaultMode: "default",
      setupActions: [connectAction],
    };
    useCodingAgentWorkspace.setState({
      summary: { providers: [provider] } as never,
      status: "ready",
      refresh: vi.fn(async () => undefined),
    });
    let resolveSetupSession!: (value: { name: string }) => void;
    const post = vi.fn(() => new Promise<{ name: string }>((resolve) => {
      resolveSetupSession = resolve;
    }));
    useConnection.setState({
      api: {
        get: vi.fn(async (path: string) => {
          if (path.startsWith("/api/chat-providers")) return catalog;
          throw new Error(`unexpected GET ${path}`);
        }),
        post,
      } as never,
    });
    useHermesChat.setState({ messages: [], status: "idle" });
    render(<ChatTab />);

    fireEvent.click(screen.getByRole("button", { name: "Choose model and provider" }));
    fireEvent.click(await screen.findByRole("button", { name: "Claude Code harness, Unavailable" }));
    fireEvent.click(await screen.findByRole("button", { name: "Connect Claude" }));

    await waitFor(() => expect(post).toHaveBeenCalledWith(
      "/api/terminal/sessions",
      expect.objectContaining({ cmd: "claude" }),
    ));
    await act(async () => resolveSetupSession({ name: "matrix-setup-claude" }));
    expect(useTabs.getState().tabs).toContainEqual(expect.objectContaining({
      kind: "terminals",
      title: "Terminal",
    }));
    expect(useTabs.getState().terminalSessionRequest?.sessionName).toBe("matrix-setup-claude");
  });

  it("persists Global Chat effort and permission selections", async () => {
    const catalog = createLegacyGlobalProviderCatalog({ hasProject: true });
    const availableCatalog = {
      ...catalog,
      instances: catalog.instances.map((instance) => ({
        ...instance,
        availability: "available" as const,
        models: instance.models.map((model) => ({ ...model, availability: "available" as const })),
        defaultSelection: { instanceId: instance.id, model: instance.models[0]!.id, options: [] },
      })),
    };
    useConnection.setState({
      api: {
        get: vi.fn(async (path: string) => {
          if (path.startsWith("/api/chat-providers")) return availableCatalog;
          throw new Error(`unexpected GET ${path}`);
        }),
      } as never,
    });
    useHermesChat.setState({ messages: [], status: "idle" });
    render(<ChatTab />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Reasoning" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Reasoning" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "High" }));
    fireEvent.click(screen.getByRole("button", { name: "Permission mode" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "full access" }));

    expect(useProviderPreferences.getState().composerSelections.hermes_default).toEqual({
      model: "provider-default",
      options: [{ id: "effort", value: "high" }],
      permissionMode: "full_access",
    });
  });

  it("explains when a coding harness cannot open without a project", () => {
    useBoard.setState({ projects: [], activeProjectSlug: null });
    useHermesChat.setState({ messages: [], status: "idle" });

    render(<ChatTab />);

    fireEvent.click(screen.getByRole("button", { name: "Choose model and provider" }));
    const codex = screen.getByRole("button", { name: "Codex harness, Unavailable" });
    expect(codex.getAttribute("aria-disabled")).toBe("true");
  });

  it("does not intercept a text-only drop in Chat", () => {
    useHermesChat.setState({ messages: [], status: "idle", send: vi.fn(() => true), abort: vi.fn() });
    render(<ChatTab />);

    const pane = screen.getByRole("region", { name: "Hermes conversation" });
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", {
      value: { items: [{ kind: "string" }], files: [] },
    });
    pane.dispatchEvent(drop);

    expect(drop.defaultPrevented).toBe(false);
    expect(screen.queryByRole("group", { name: "Attachments" })).toBeNull();
  });

  it("renders the persistent Hermes index newest-first with bounded metadata", () => {
    useHermesChat.setState({
      view: "index",
      indexStatus: "ready",
      indexError: null,
      conversations: [
        {
          id: "conversation-new",
          title: "Plan the launch",
          preview: "Review the final launch checklist",
          messageCount: 4,
          createdAt: 20,
          updatedAt: 30,
        },
        {
          id: "conversation-old",
          title: "Earlier notes",
          preview: "Summarize the customer interview",
          messageCount: 2,
          createdAt: 10,
          updatedAt: 15,
        },
      ],
    });

    render(<ChatTab />);

    expect(screen.getByRole("heading", { name: "Chats" })).toBeTruthy();
    const newest = screen.getByRole("button", { name: "Plan the launch conversation" });
    const older = screen.getByRole("button", { name: "Earlier notes conversation" });
    expect(newest.textContent).toContain("Plan the launch");
    expect(newest.textContent).toContain("Hermes");
    expect(newest.textContent).not.toContain("4 messages");
    expect(newest.textContent).not.toContain("Review the final launch checklist");
    expect(older.textContent).toContain("Earlier notes");
    expect(screen.queryByText("hello")).toBeNull();
  });

  it("renders the Chat home with the approved handoff hierarchy", () => {
    useHermesChat.setState({
      view: "index",
      indexStatus: "ready",
      indexError: null,
      conversations: [{
        id: "conversation-one",
        title: "Plan the launch",
        preview: "Review the final launch checklist",
        messageCount: 4,
        createdAt: 20,
        updatedAt: 30,
      }],
    });

    const { container } = render(<ChatTab />);

    const content = container.querySelector<HTMLElement>("[data-chat-index-content]");
    const header = container.querySelector<HTMLElement>("[data-chat-index-header]");
    const list = container.querySelector<HTMLElement>("[data-chat-index-list]");
    const row = container.querySelector<HTMLElement>("[data-conversation-row]");
    expect(content?.className).toContain("max-w-[1020px]");
    expect(header?.className).toContain("min-h-[47px]");
    expect(header?.className).toContain("mb-2");
    expect(list?.className).not.toContain("rounded");
    expect(list?.className).not.toContain("border");
    expect(row?.className).toContain("h-16");
    expect(screen.getByRole("button", { name: "Search chats" }).className).toContain("border");
    expect(screen.getByRole("button", { name: "New chat" }).style.background).toBe("var(--accent)");
  });

  it("shows loading, empty, and safe recovery states for conversation discovery", () => {
    useHermesChat.setState({ view: "index", indexStatus: "loading", conversations: [], indexError: null });
    const { rerender } = render(<ChatTab />);
    expect(screen.getByRole("status", { name: "Loading chats" })).toBeTruthy();

    act(() => useHermesChat.setState({ indexStatus: "ready", conversations: [] }));
    rerender(<ChatTab />);
    expect(screen.getByRole("heading", { name: "No chats yet" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "New chat" })).toBeTruthy();

    act(() => useHermesChat.setState({
      indexStatus: "error",
      indexError: "Conversations could not be loaded. Try again.",
    }));
    rerender(<ChatTab />);
    expect(screen.getByRole("alert").textContent).toContain("Conversations could not be loaded. Try again.");
    expect(screen.getByRole("button", { name: "Retry chats" })).toBeTruthy();
  });

  it("automatically retries a transient initial conversation index failure", async () => {
    vi.useFakeTimers();
    try {
      let conversationCalls = 0;
      const get = vi.fn(async (path: string) => {
        if (path.startsWith("/api/chats")) return { legacy: true };
        conversationCalls += 1;
        if (conversationCalls === 1) throw new Error("offline");
        return [{
          id: "conversation-recovered",
          preview: "Back online",
          messageCount: 1,
          createdAt: 10,
          updatedAt: 20,
        }];
      });
      useConnection.setState({ api: { get } as never });
      useHermesChat.setState({
        view: "index",
        indexStatus: "idle",
        indexError: null,
        conversations: [],
      });

      render(<ChatTab />);
      await act(async () => { await Promise.resolve(); });
      expect(conversationCalls).toBe(1);
      expect(useHermesChat.getState().indexStatus).toBe("error");

      await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });

      expect(conversationCalls).toBe(2);
      expect(useHermesChat.getState().indexStatus).toBe("ready");
      expect(useHermesChat.getState().conversations).toEqual([
        expect.objectContaining({ id: "conversation-recovered", title: "Back online" }),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("marks only the selected live conversation as running", () => {
    useHermesChat.setState({
      view: "index",
      sessionId: "conversation-selected",
      status: "streaming",
      indexStatus: "ready",
      conversations: [
        {
          id: "conversation-newer",
          title: "Newer but idle",
          preview: "idle",
          messageCount: 1,
          createdAt: 20,
          updatedAt: 30,
        },
        {
          id: "conversation-selected",
          title: "Selected and live",
          preview: "running",
          messageCount: 2,
          createdAt: 10,
          updatedAt: 15,
        },
      ],
    });

    render(<ChatTab />);

    expect(screen.getByRole("button", { name: "Selected and live conversation" }).textContent).toContain("Running");
    expect(screen.getByRole("button", { name: "Newer but idle conversation" }).textContent).not.toContain("Running");
  });

  it("creates and opens a server-backed empty conversation", async () => {
    const post = vi.fn().mockResolvedValue({ id: "conversation-created" });
    const get = vi.fn().mockResolvedValue([
      {
        id: "conversation-created",
        preview: "",
        messageCount: 0,
        createdAt: 100,
        updatedAt: 100,
      },
    ]);
    useConnection.setState({ api: { post, get } as never });
    useHermesChat.setState({ view: "index", indexStatus: "ready", conversations: [] });

    render(<ChatTab />);
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));

    expect(await screen.findByRole("region", { name: "Hermes conversation" })).toBeTruthy();
    expect(useHermesChat.getState()).toMatchObject({
      view: "conversation",
      sessionId: "conversation-created",
      messages: [],
    });
  });

  it("opens the selected canonical conversation without duplicating global navigation", async () => {
    const get = vi.fn().mockResolvedValue({
      id: "conversation-one",
      createdAt: 10,
      updatedAt: 20,
      totalCount: 1,
      messages: [
        { index: 0, role: "user", content: "persistent hello", contentTruncated: false, timestamp: 10 },
      ],
      hasMore: false,
      limit: 50,
    });
    useConnection.setState({ api: { get } as never });
    useHermesChat.setState({
      view: "index",
      indexStatus: "ready",
      conversations: [{
        id: "conversation-one",
        title: "Persistent plan",
        preview: "persistent hello",
        messageCount: 1,
        createdAt: 10,
        updatedAt: 20,
      }],
    });

    render(<ChatTab />);
    fireEvent.click(screen.getByRole("button", { name: /persistent plan conversation/i }));

    expect(await screen.findByText("persistent hello")).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: "Chat breadcrumb" })).toBeNull();
    expect(useHermesChat.getState().sessionId).toBe("conversation-one");
  });
});
