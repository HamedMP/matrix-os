// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useChatSubmissionError } from "@desktop/renderer/src/features/chat/use-chat-submission-error";

describe("composer submission feedback ownership", () => {
  const initial = { scope: "chat:one", revision: 1, attachments: ["upload-one"] };
  it.each([
    { ...initial, scope: "chat:two" },
    { ...initial, revision: 2 },
    { ...initial, attachments: [] },
  ])("hides feedback when its input changes: $scope / $revision / $attachments", next => {
    const hook = renderHook(({ scope, revision, attachments }) => useChatSubmissionError(scope, revision, attachments), { initialProps: initial });
    act(() => hook.result.current[1]("The previous selection was too large."));
    hook.rerender(next);
    expect(hook.result.current[0]).toBeNull();
  });

  it("keeps feedback for the unchanged draft on a harmless rerender", () => {
    const hook = renderHook(({ scope, revision, attachments }) => useChatSubmissionError(scope, revision, attachments), { initialProps: initial });
    act(() => hook.result.current[1]("Upload failed."));
    hook.rerender({ ...initial, attachments: [...initial.attachments] });
    expect(hook.result.current[0]).toBe("Upload failed.");
  });

  it("ignores both stale failure and stale clear callbacks after a route change", () => {
    const hook = renderHook(({ scope, revision, attachments }) => useChatSubmissionError(scope, revision, attachments), { initialProps: initial });
    const oldSetter = hook.result.current[1];
    hook.rerender({ ...initial, scope: "chat:two" });
    act(() => hook.result.current[1]("Current upload failed."));
    act(() => oldSetter("Old upload failed."));
    expect(hook.result.current[0]).toBe("Current upload failed.");
    act(() => oldSetter(null));
    expect(hook.result.current[0]).toBe("Current upload failed.");
  });
});
