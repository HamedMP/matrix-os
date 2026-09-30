import { expect, it } from "vitest";
import { createAssistantTextStreamProjector, safePublishedText, sanitizeAssistantText } from "../../packages/gateway/src/chat/safe-activity-projection";

it("preserves exact public Matrix collection routes in an explanation across every split", () => {
  const input = "The `/api/integrations` layer and `/api/apps` catalog are available.";
  const options = { homePath: "/home/matrix/home" };
  expect(sanitizeAssistantText(input, options)).toBe(input);
  for (let split = 0; split <= input.length; split++) {
    const stream = createAssistantTextStreamProjector(options);
    expect(stream.push(input.slice(0, split)) + stream.push(input.slice(split)) + stream.flush()).toBe(input);
  }
  for (const path of ["/private/file", "/api/integrations/private", "/api/apps?token=private", "/etc/passwd"]) {
    expect(sanitizeAssistantText(`Inspect ${path}`, options)).toBe("Inspect [redacted path]");
  }
  expect(sanitizeAssistantText("ACCESS_TOKEN=fixture-private", options)).toBe("[redacted credential]");
});

it("preserves punctuation after exact routes without exempting route suffixes", () => {
  const options = { homePath: "/home/matrix/home" };
  const input = "Use /api/integrations. Or /api/apps, then /api/apps; done.";
  expect(sanitizeAssistantText(input, options)).toBe(input);
  expect(safePublishedText(input, options)).toBe(input);
  for (let split = 0; split <= input.length; split++) {
    const stream = createAssistantTextStreamProjector(options);
    expect(stream.push(input.slice(0, split)) + stream.push(input.slice(split)) + stream.flush()).toBe(input);
  }
  for (const suffix of [".private", "?token=private.", "/private.", "#private."]) {
    expect(sanitizeAssistantText(`/api/apps${suffix}`, options)).toBe("[redacted path]");
  }
});

it("shows complete paths in a private Chat while keeping credentials hidden", () => {
  const options = { homePath: "/home/matrix/home", showPrivatePaths: true };
  const input = "Open /home/matrix/home/apps/chart/index.html and /opt/matrix/app/log.txt.";
  expect(sanitizeAssistantText(input, options)).toBe(input);
  expect(safePublishedText(input, options)).toBe(input);
  for (let split = 0; split <= input.length; split++) {
    const stream = createAssistantTextStreamProjector(options);
    expect(stream.push(input.slice(0, split)) + stream.push(input.slice(split)) + stream.flush()).toBe(input);
  }
  expect(sanitizeAssistantText("Bearer private-token", options)).toBe("Bearer [redacted]");
  expect(sanitizeAssistantText("ACCESS_TOKEN=private-token", options)).toBe("[redacted credential]");
  expect(sanitizeAssistantText("Open /api/apps?token=private-token", options)).toBe("Open [redacted path]");
});
