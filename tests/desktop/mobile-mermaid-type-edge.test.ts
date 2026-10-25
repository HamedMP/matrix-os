import { createRequire } from "node:module";
import { resolve } from "node:path";
import { realpathSync } from "node:fs";
import { expect, it } from "vitest";
it("resolves React types from the native diagram WebView in the pnpm virtual store", () => {
  const require = createRequire(realpathSync(resolve("apps/mobile/node_modules/react-native-webview/package.json")));
  expect(require.resolve("@types/react/package.json")).toContain("@types");
});
