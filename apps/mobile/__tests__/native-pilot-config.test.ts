const originalTarget = process.env.EXPO_PUBLIC_MATRIX_HOSTED_ORIGIN;
afterEach(() => {
  if (originalTarget === undefined) delete process.env.EXPO_PUBLIC_MATRIX_HOSTED_ORIGIN;
  else process.env.EXPO_PUBLIC_MATRIX_HOSTED_ORIGIN = originalTarget;
});

it("preserves static production config and isolates pilot native identity and updates", () => {
  const base = require("../app.json").expo;
  const config = require("../app.config");
  delete process.env.EXPO_PUBLIC_MATRIX_HOSTED_ORIGIN;
  expect(config({ config: base })).toEqual(base);
  process.env.EXPO_PUBLIC_MATRIX_HOSTED_ORIGIN = "https://gmail-pilot.matrix-os.com";
  const pilot = config({ config: base });
  expect(pilot.name).toBe("Matrix OS Gmail Pilot");
  expect(pilot.scheme).toBe("matrixos-gmail-pilot");
  expect(pilot.ios.bundleIdentifier).toBe("com.matrixos.mobile.gmailpilot");
  expect(pilot.android.package).toBe("com.matrixos.mobile.gmailpilot");
  expect(pilot.updates.enabled).toBe(false);
  expect(pilot.runtimeVersion).toBe(`gmail-pilot-${base.version}`);
  expect(pilot.plugins).toContainEqual(["expo-dev-client", { addGeneratedScheme: false }]);
  expect(base.ios.bundleIdentifier).toBe("com.matrixos.mobile");
  process.env.EXPO_PUBLIC_MATRIX_HOSTED_ORIGIN = "https://untrusted.invalid";
  expect(() => config({ config: base })).toThrow();
});
