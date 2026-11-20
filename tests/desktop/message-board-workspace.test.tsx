// @vitest-environment jsdom

import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TabPane } from "@desktop/renderer/src/features/mission-control/TabContent";
import { createDesktopMessageBoardClient } from "@desktop/renderer/src/features/message-board/desktop-board-client";
import { boardUnauthorizedHandler } from "@desktop/renderer/src/features/message-board/board-session";
import { advanceRuntimeGeneration, captureRuntimeGeneration } from "@desktop/renderer/src/stores/runtime-generation";
import { useConnection } from "@desktop/renderer/src/stores/connection";
import type { ApiClient } from "@desktop/renderer/src/lib/api";
import { createLiveBoard, OWNER } from "../ui/message-board-harness";

const HOST = "https://app.matrix-os.com";

/** The platform's job in production: route by `runtime`, then strip it before the computer's routes. */
function platformFetch(live: Awaited<ReturnType<typeof createLiveBoard>>, seen: string[]) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    seen.push(url.searchParams.get("runtime") ?? "primary");
    url.searchParams.delete("runtime");
    return live.app.request(`${url.pathname}${url.search}`, init);
  }) as unknown as typeof fetch;
}

describe("Electron Desktop Message Board", () => {
  let live: Awaited<ReturnType<typeof createLiveBoard>>;
  beforeEach(async () => { live = await createLiveBoard(); });
  afterEach(async () => {
    cleanup();
    vi.unstubAllGlobals();
    await live.close();
  });

  // Fault detected: board requests that skip the runtime slot reach the primary computer's board
  // from a preview or secondary computer, and live updates connect to the wrong board.
  it("sends every board request and the live socket to the selected computer", async () => {
    const seen: string[] = [];
    const sockets: string[] = [];
    const client = createDesktopMessageBoardClient({
      platformHost: HOST, runtimeSlot: "pr-42", fetch: platformFetch(live, seen),
      createSocket: (url) => {
        sockets.push(url);
        return { send: () => undefined, close: () => undefined, onopen: null, onmessage: null, onclose: null, onerror: null };
      },
    });
    await live.runtime.service.post(live.as(OWNER), undefined, { channel: "dev", text: "Deploy notes" });
    expect((await client.listChannels("General")).map((channel) => channel.path)).toEqual(["dev"]);
    expect((await client.listThreads("General", "dev")).map((thread) => thread.root.text)).toEqual(["Deploy notes"]);
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen)).toEqual(new Set(["pr-42"]));
    const stop = client.subscribe("General", () => undefined);
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    expect(sockets[0]).toMatch(/^wss:\/\/app\.matrix-os\.com\/ws\/board\/events\?.*runtime=pr-42/);
    stop();
  });

  it("reports an expired desktop session once the board answers 401", async () => {
    const onUnauthorized = vi.fn();
    const client = createDesktopMessageBoardClient({
      platformHost: HOST, runtimeSlot: "primary", onUnauthorized,
      fetch: (async () => Response.json({ error: "Sign in again", reason: "unauthorized" }, { status: 401 })) as unknown as typeof fetch,
    });
    await expect(client.listChannels("General")).rejects.toBeTruthy();
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  // Fault detected (review): a 401 from the board of a computer the owner already left (or an
  // older sign-in) expired the fresh session and signed the owner out.
  it("lets only the session that sent a request expire the sign-in", () => {
    useConnection.setState({ authGeneration: 3 });
    const expire = vi.fn();
    const current = boardUnauthorizedHandler({ authGeneration: 3, runtimeGeneration: captureRuntimeGeneration() }, expire);
    current();
    expect(expire).toHaveBeenCalledOnce();
    useConnection.setState({ authGeneration: 4 });
    current();
    const beforeSwitch = boardUnauthorizedHandler({ authGeneration: 4, runtimeGeneration: captureRuntimeGeneration() }, expire);
    advanceRuntimeGeneration();
    beforeSwitch();
    expect(expire).toHaveBeenCalledOnce();
  });

  it("opens the shared viewer in a Message Board tab", async () => {
    vi.stubGlobal("fetch", platformFetch(live, []));
    useConnection.setState({ platformHost: HOST, runtimeSlot: "primary", api: {} as ApiClient });
    render(<TabPane tab={{ id: "board", kind: "message-board", title: "Message Board", closable: true }} active />);
    expect((await screen.findByText("Nothing posted yet")).textContent).toBe("Nothing posted yet");
  });
});
