import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const gatewayName = "customer-vps.matrix-os.local";

export function makeSlackDevCertificate(commonName = gatewayName) {
  const directory = mkdtempSync(join(tmpdir(), "slack-dev-cert-"));
  const keyPath = join(directory, "key.pem");
  const certPath = join(directory, "cert.pem");
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
      "-subj", "/CN=" + commonName, "-keyout", keyPath, "-out", certPath], { stdio: "ignore" });
    return {
      key: readFileSync(keyPath, "utf8"),
      cert: readFileSync(certPath, "utf8"),
      issueUnpinnedLeaf() {
        const leafKey = join(directory, "leaf-key.pem");
        const leafCsr = join(directory, "leaf.csr");
        const leafCert = join(directory, "leaf.pem");
        execFileSync("openssl", ["req", "-new", "-nodes", "-newkey", "rsa:2048", "-subj", "/CN=" + gatewayName,
          "-keyout", leafKey, "-out", leafCsr], { stdio: "ignore" });
        execFileSync("openssl", ["x509", "-req", "-days", "1", "-in", leafCsr, "-CA", certPath, "-CAkey", keyPath,
          "-set_serial", "2", "-out", leafCert], { stdio: "ignore" });
        return { key: readFileSync(leafKey, "utf8"), cert: readFileSync(leafCert, "utf8") };
      },
      close: () => rmSync(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}
