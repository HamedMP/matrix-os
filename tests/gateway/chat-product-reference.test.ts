import { expect, it } from "vitest";
import { createAssistantTextStreamProjector, sanitizeAssistantText } from "../../packages/gateway/src/chat/safe-activity-projection";

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
