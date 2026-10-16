import { expect, it } from "vitest";
import { z } from "zod/v4";
import {
  codexBrowserChildEnvironment,
  codexBrowserThreadConfig,
} from "../../packages/gateway/src/coding-agents/codex-browser-bootstrap.mjs";

it("retains a valid stdio transport when shared Chrome is disabled", () => {
  // Codex validates the transport even when enabled is false. A partial
  // { enabled: false } entry fails thread/start before any inference.
  const disabled = codexBrowserThreadConfig(undefined)["mcp_servers.matrix_shared_browser"];
  expect(z.object({
    command: z.string().min(1),
    args: z.array(z.string()),
    enabled: z.literal(false),
  }).safeParse(disabled).success).toBe(true);
  expect(disabled).toMatchObject({
    command: "/opt/matrix/runtime/node/bin/node",
    args: ["/opt/matrix/app/packages/integrations-mcp/dist/shared-browser-cli.js"],
  });
  expect(disabled).not.toHaveProperty("env_vars");
  expect(disabled).not.toHaveProperty("required");
});

it("does not pass inherited browser credentials without an admitted lease", () => {
  expect(codexBrowserChildEnvironment({
    PATH: "/usr/bin",
    MATRIX_SHARED_BROWSER_TOKEN: "stale-browser-credential",
    MATRIX_SHARED_BROWSER_GATEWAY_PORT: "4000",
  }, undefined)).toEqual({ PATH: "/usr/bin" });
});
