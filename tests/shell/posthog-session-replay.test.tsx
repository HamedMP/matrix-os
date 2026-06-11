// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const posthogMock = vi.hoisted(() => ({
  init: vi.fn(),
  capture: vi.fn(),
  identify: vi.fn(),
  reset: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock("posthog-js", () => ({
  default: posthogMock,
}));

const TEST_CONFIG = {
  token: "phc_test",
  apiHost: "/relay",
  uiHost: "https://eu.posthog.com",
};

async function importShellPostHog() {
  vi.resetModules();
  return import("../../shell/src/lib/posthog-client");
}

describe("shell session replay init", () => {
  beforeEach(() => {
    posthogMock.init.mockClear();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("enables masked session recording with console log capture", async () => {
    const { initializeShellPostHog } = await importShellPostHog();

    initializeShellPostHog("US", TEST_CONFIG);

    expect(posthogMock.init).toHaveBeenCalledTimes(1);
    const [, options] = posthogMock.init.mock.calls[0] as [string, Record<string, unknown>];
    expect(options.disable_session_recording).toBe(false);
    expect(options.enable_recording_console_log).toBe(true);
    expect(options.session_recording).toEqual({
      maskAllInputs: true,
      maskTextSelector: "[data-ph-mask]",
      blockSelector: ".ph-no-capture",
    });
  });

  it("keeps session recording disabled when NEXT_PUBLIC_POSTHOG_DISABLE_REPLAY is set", async () => {
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_DISABLE_REPLAY", "1");
    const { initializeShellPostHog } = await importShellPostHog();

    initializeShellPostHog("US", TEST_CONFIG);

    expect(posthogMock.init).toHaveBeenCalledTimes(1);
    const [, options] = posthogMock.init.mock.calls[0] as [string, Record<string, unknown>];
    expect(options.disable_session_recording).toBe(true);
  });
});

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

describe("ph-no-capture privacy surfaces", () => {
  it("blocks chat transcripts from session recording via the shared Conversation container", async () => {
    globalThis.ResizeObserver = ResizeObserverMock as unknown as typeof ResizeObserver;
    const { Conversation, ConversationContent } = await import(
      "../../shell/src/components/ai-elements/conversation.js"
    );

    render(
      <Conversation>
        <ConversationContent>
          <div data-testid="chat-message">hello</div>
        </ConversationContent>
      </Conversation>,
    );

    const message = screen.getByTestId("chat-message");
    expect(message.closest(".ph-no-capture")).not.toBeNull();
    // The recording-blocked container is the transcript log itself.
    expect(screen.getByRole("log").classList.contains("ph-no-capture")).toBe(true);
  });

  it("keeps the ChatPopover message list out of session recording", () => {
    const source = readFileSync(
      join(process.cwd(), "shell/src/components/ChatPopover.tsx"),
      "utf8",
    );
    expect(source).toMatch(/ph-no-capture[^"]*"[^>]*ref=\{attachScrollRef\}|ref=\{attachScrollRef\}[^>]*ph-no-capture/s);
  });
});
