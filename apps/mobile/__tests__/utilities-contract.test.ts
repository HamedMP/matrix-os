import { utilitiesAppCsp } from "@matrix-os/contracts";

test("the shared Utilities policy loads through the Native Mobile contract entrypoint", () => {
  const policy = utilitiesAppCsp();
  expect(policy).toContain("default-src 'self'");
  expect(policy).toContain("object-src 'none'");
  expect(policy).not.toContain("connect-src *");
});
