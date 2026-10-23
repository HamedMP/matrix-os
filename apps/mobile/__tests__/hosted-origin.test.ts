const originalTarget = process.env.EXPO_PUBLIC_MATRIX_HOSTED_ORIGIN;
const production = "https://app.matrix-os.com";
const pilot = "https://gmail-pilot.matrix-os.com";
afterEach(() => {
  if (originalTarget === undefined) delete process.env.EXPO_PUBLIC_MATRIX_HOSTED_ORIGIN;
  else process.env.EXPO_PUBLIC_MATRIX_HOSTED_ORIGIN = originalTarget;
  jest.resetModules();
});

it.each([undefined, production, pilot])("loads only an operator-built trusted origin: %s", target => {
  if (target === undefined) delete process.env.EXPO_PUBLIC_MATRIX_HOSTED_ORIGIN;
  else process.env.EXPO_PUBLIC_MATRIX_HOSTED_ORIGIN = target;
  jest.resetModules();
  const { HOSTED_GATEWAY_URL } = require("../lib/hosted-origin");
  expect(HOSTED_GATEWAY_URL).toBe(target ?? production);
  process.env.EXPO_PUBLIC_MATRIX_HOSTED_ORIGIN = "https://attacker.invalid";
  expect(HOSTED_GATEWAY_URL).toBe(target ?? production); // Snapshot, never a runtime URL selector.
});

it.each(["", " ", ` ${pilot}`, `${pilot}/`, `${pilot}/vm/test`, `${pilot}?x=1`, `${pilot}#x`,
  "http://gmail-pilot.matrix-os.com", "https://gmail-pilot.matrix-os.com:444",
  "https://user@gmail-pilot.matrix-os.com", "https://gmail-pilot.matrix-os.com.attacker.invalid",
  "https://custom.invalid", "https://app.matrix-os.com.evil.invalid", "HTTPS://GMAIL-PILOT.MATRIX-OS.COM",
])("fails closed instead of silently selecting production for %s", target => {
  process.env.EXPO_PUBLIC_MATRIX_HOSTED_ORIGIN = target;
  jest.resetModules();
  expect(() => require("../lib/hosted-origin")).toThrow("Mobile hosted target unavailable");
});
