import { X509Certificate } from "node:crypto";
import { checkServerIdentity } from "node:tls";
import { Agent } from "undici";

const devIngressHostname = "customer-vps.matrix-os.local";
const certificatePem = /^-----BEGIN CERTIFICATE-----\r?\n(?:[A-Za-z0-9+/=]+\r?\n)+-----END CERTIFICATE-----$/;

export function loadSlackDevIngressCertificate(value: string | undefined): X509Certificate {
  try {
    const pem = value?.trim();
    if (!pem || pem.length > 8192 || !certificatePem.test(pem)) throw new Error("Expected one certificate");
    const certificate = new X509Certificate(pem);
    const now = Date.now();
    if (certificate.checkHost(devIngressHostname, { wildcards: false }) !== devIngressHostname
      || certificate.subject !== certificate.issuer || !certificate.verify(certificate.publicKey)
      || now < certificate.validFromDate.getTime() || now >= certificate.validToDate.getTime()) {
      throw new Error("Invalid Dev ingress certificate");
    }
    return certificate;
  } catch (error: unknown) {
    throw new Error("Slack Dev ingress certificate unavailable", { cause: error });
  }
}

/** This pool is for the registered Dev Gateway IP, with the platform-provisioned nginx name. */
export function createSlackDevHomeDispatcher(certificate: X509Certificate): Agent {
  return new Agent({
    connections: 2,
    connect: {
      ca: certificate.toString(),
      servername: devIngressHostname,
      rejectUnauthorized: true,
      checkServerIdentity(_hostname, peer) {
        return checkServerIdentity(devIngressHostname, peer)
          ?? (peer.fingerprint256 === certificate.fingerprint256 ? undefined : new Error("Slack Dev ingress certificate changed"));
      },
    },
  });
}
