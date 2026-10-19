import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Linux qualification always runs on Linux; missing native prerequisites fail.
describe.runIf(process.platform === "linux")("native ext4 generation policy (Linux)", () => {
  let directory: string;
  let addon: { readIdentity(fd: number): Buffer };
  const original = process.env.MATRIX_IDENTITY_TEST_CASE;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "matrix-identity-policy-"));
    const root = fileURLToPath(new URL("../..", import.meta.url));
    const includes = [resolve(dirname(process.execPath), "../include/node"), "/usr/include/node", "/usr/local/include/node"];
    const include = includes.find((path) => existsSync(join(path, "node_api.h")));
    if (!include) throw new Error("N-API headers unavailable");
    const binary = join(directory, "policy.node");
    execFileSync(process.env.CC || "cc", ["-std=c11", "-Wall", "-Wextra", "-Werror", "-shared", "-fPIC", "-DNAPI_VERSION=8", `-I${include}`,
      "-Dfstat=mock_fstat", "-Dfstatfs=mock_fstatfs", "-Dname_to_handle_at=mock_name_to_handle_at", "-Dgeteuid=mock_geteuid", "-Dprctl=mock_prctl", "-Dioctl=mock_ioctl",
      join(root, "packages/gateway/native/filesystem-identity.c"), join(root, "tests/gateway/fixtures/filesystem-identity-syscalls.c"), "-o", binary], { timeout: 30_000 });
    addon = createRequire(import.meta.url)(binary) as typeof addon;
  });
  afterAll(async () => {
    if (original === undefined) delete process.env.MATRIX_IDENTITY_TEST_CASE;
    else process.env.MATRIX_IDENTITY_TEST_CASE = original;
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  function read(scenario: string) { process.env.MATRIX_IDENTITY_TEST_CASE = scenario; return addon.readIdentity(7); }
  it.each(["foreign_owner", "seccomp", "uuid_missing", "uuid_bad_length", "uuid_bad_flags", "uuid_zero", "mutable_generation", "not_permitted", "read_only", "unexpected_success"])("fails closed for %s", (scenario) => {
    expect(() => read(scenario)).toThrow();
  });
  it("accepts only the proven ext4 capability and includes full UUID", () => {
    const bytes = read("protected");
    expect(bytes.subarray(0, 4).toString()).toBe("MFI2");
    expect(bytes.subarray(8, 24)).toEqual(Buffer.alloc(16, 1));
  });
  it("keeps tmpfs independent of the ext4 ioctl gate", () => {
    expect(read("tmpfs").subarray(0, 4).toString()).toBe("MFI2");
  });
});
