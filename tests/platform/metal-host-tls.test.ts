import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const DIR = "distro/metal-host";
const run = promisify(execFile);

describe("hostd TLS certificate provisioning", () => {
  let work: string;

  beforeAll(async () => { work = await mkdtemp(join(tmpdir(), "metal-host-tls-")); });
  afterAll(async () => { await rm(work, { recursive: true, force: true }); });

  it("preserves an installed CA-signed TLS pair even within seven days of expiry", async () => {
    const tls = await mkdtemp(join(work, "tls-installed-"));
    const ca = join(tls, "ca.pem");
    const caKey = join(tls, "ca-key.pem");
    const key = join(tls, "key.pem");
    const cert = join(tls, "cert.pem");
    const csr = join(tls, "server.csr");
    await run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "8", "-subj", "/CN=Test CA", "-out", ca, "-keyout", caKey]);
    await run("openssl", ["req", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=host.example.test", "-out", csr, "-keyout", key]);
    await run("openssl", ["x509", "-req", "-in", csr, "-CA", ca, "-CAkey", caKey, "-CAcreateserial", "-days", "1", "-out", cert]);
    const before = await Promise.all([readFile(cert, "utf8"), readFile(key, "utf8")]);

    for (const extra of [[], ["--smoke"]]) {
      const { stdout } = await run("bash", [`${DIR}/matrix-hostd-tls`, tls, "host.example.test", ...extra]);
      expect(stdout).toBe("");
      expect(await Promise.all([readFile(cert, "utf8"), readFile(key, "utf8")])).toEqual(before);
      await expect(run("openssl", ["verify", "-CAfile", ca, cert])).resolves.toMatchObject({ stdout: `${cert}: OK\n` });
    }
  });

  it("only creates a smoke certificate on explicit opt-in and preserves a partial install", async () => {
    const tls = join(work, "tls-smoke");
    const helper = [`${DIR}/matrix-hostd-tls`, tls, "host.example.test"];
    await expect(run("bash", helper)).rejects.toMatchObject({ stderr: expect.stringContaining("--smoke-tls") });
    expect(existsSync(tls)).toBe(false);
    expect((await run("bash", [...helper, "--smoke"])).stdout).toBe("changed\n");
    expect((await stat(join(tls, "key.pem"))).mode & 0o777).toBe(0o600);
    expect((await run("openssl", ["x509", "-in", join(tls, "cert.pem"), "-noout", "-ext", "subjectAltName"])).stdout)
      .toContain("DNS:host.example.test");
    const partial = join(work, "tls-partial");
    await mkdir(partial);
    await writeFile(join(partial, "cert.pem"), "operator certificate");
    await expect(run("bash", [helper[0]!, partial, "host.example.test", "--smoke"])).rejects.toMatchObject({
      stderr: expect.stringContaining("install both"),
    });
    expect(await readFile(join(partial, "cert.pem"), "utf8")).toBe("operator certificate");
    expect(existsSync(join(partial, "key.pem"))).toBe(false);
  });
});
