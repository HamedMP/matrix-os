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

it.each([production, pilot])("reserves both built-in hostnames across normalize/save/restore/Basic aliases in %s", async target => {
  process.env.EXPO_PUBLIC_MATRIX_HOSTED_ORIGIN = target;
  jest.resetModules();
  const storage = require("../lib/storage");
  const secure = require("expo-secure-store");
  secure.setItemAsync.mockClear();
  secure.deleteItemAsync.mockClear();
  for (const hostname of ["app.matrix-os.com", "gmail-pilot.matrix-os.com"]) {
    for (const alias of [
      `http://${hostname}/vm/other-box`,
      `https://${hostname}:444/vm/other-box`,
      `https://${hostname}./vm/other-box`,
      `https://${hostname.toUpperCase()}.:444/vm/other-box`,
      `https://${hostname}../vm/other-box`,
      `https://user:fixture@${hostname}/vm/other-box`,
    ]) {
      expect(() => storage.normalizeGatewayUrl(alias)).toThrow();
      await expect(storage.saveSelectedGatewayUrl(alias)).rejects.toThrow();
      await expect(storage.saveSelectedGatewayBasicAuth(alias, "owner", "fixture-password")).rejects.toThrow();
      secure.getItemAsync.mockResolvedValue(JSON.stringify({ id: "matrix-os-custom", url: alias }));
      await expect(storage.getSelectedGatewayConnection()).resolves.toMatchObject({ url: target });
    }
  }
  expect(secure.setItemAsync).not.toHaveBeenCalled();
  expect(secure.deleteItemAsync).not.toHaveBeenCalled();
  // Normalization must not reserve unrelated user-operated/custom hosts.
  expect(storage.normalizeGatewayUrl("https://custom.example.invalid:444/vm/owner/"))
    .toBe("https://custom.example.invalid:444/vm/owner");
  expect(storage.normalizeGatewayUrl("https://app.matrix-os.com.custom.invalid/"))
    .toBe("https://app.matrix-os.com.custom.invalid");
  expect(storage.normalizeGatewayUrl(target)).toBe(target);
});
