import { resolve } from "node:path";
import type { ConfigContext } from "expo/config";
import resolveConfig from "../app.config";

const originalTarget = process.env.EXPO_PUBLIC_MATRIX_HOSTED_ORIGIN;
afterEach(() => {
  if (originalTarget === undefined) delete process.env.EXPO_PUBLIC_MATRIX_HOSTED_ORIGIN;
  else process.env.EXPO_PUBLIC_MATRIX_HOSTED_ORIGIN = originalTarget;
});

it("preserves static production config and isolates pilot native identity and updates", () => {
  const base: ConfigContext["config"] = require("../app.json").expo;
  const projectRoot = resolve(__dirname, "..");
  const context: ConfigContext = {
    config: base,
    projectRoot,
    staticConfigPath: resolve(projectRoot, "app.json"),
    packageJsonPath: resolve(projectRoot, "package.json"),
  };
  delete process.env.EXPO_PUBLIC_MATRIX_HOSTED_ORIGIN;
  expect(resolveConfig(context)).toEqual(base);
  process.env.EXPO_PUBLIC_MATRIX_HOSTED_ORIGIN = "https://gmail-pilot.matrix-os.com";
  const pilot = resolveConfig(context);
  expect(pilot.name).toBe("Matrix OS Gmail Pilot");
  expect(pilot.scheme).toBe("matrixos-gmail-pilot");
  expect(pilot.ios?.bundleIdentifier).toBe("com.matrixos.mobile.gmailpilot");
  expect(pilot.android?.package).toBe("com.matrixos.mobile.gmailpilot");
  expect(pilot.updates?.enabled).toBe(false);
  expect(pilot.runtimeVersion).toBe(`gmail-pilot-${base.version}`);
  expect(pilot.plugins).toContainEqual(["expo-dev-client", { addGeneratedScheme: false }]);
  expect(base.ios?.bundleIdentifier).toBe("com.matrixos.mobile");
  process.env.EXPO_PUBLIC_MATRIX_HOSTED_ORIGIN = "https://untrusted.invalid";
  expect(() => resolveConfig(context)).toThrow();
});
