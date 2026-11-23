// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";
import { useMessageBoard } from "../../packages/ui/src/message-board/use-message-board";
import { createLiveBoard, OWNER } from "./message-board-harness";

let live: Awaited<ReturnType<typeof createLiveBoard>>;
beforeEach(async () => { live = await createLiveBoard(); });
afterEach(async () => { await live.close(); });

// Fault detected (review): every event restarted the read in flight, so events arriving faster
// than a read completes kept the view on its loading state (or stale) until posting stopped.
it("shows a slow read's result even while events keep arriving", async () => {
  await live.runtime.service.post(live.as(OWNER), undefined, { channel: "dev", text: "Deploy notes" });
  const listChannels = live.client.listChannels.bind(live.client);
  let reads = 0;
  live.client.listChannels = async (board) => {
    reads += 1;
    await new Promise((resolve) => setTimeout(resolve, 80));
    return listChannels(board);
  };
  const { result } = renderHook(() => useMessageBoard(live.client));
  // An event every 20 ms, four times faster than a read.
  for (let tick = 0; tick < 15; tick += 1) {
    act(() => result.current.reload());
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
  }
  expect(result.current.channels.data?.map((channel) => channel.path)).toEqual(["dev"]);
  // Events during a read collapse into one follow-up read, not one per event.
  await waitFor(() => expect(result.current.channels.status).toBe("ready"));
  expect(reads).toBeLessThan(8);
});
