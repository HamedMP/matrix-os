import { describe, expect, it } from "vitest";
import { resolveWindowsSigningConfig } from "../../scripts/release/windows-signing-config.mjs";

const azureEnvironment = {
  MATRIX_DESKTOP_WINDOWS_SIGNING_MODE: "azure",
  MATRIX_DESKTOP_WINDOWS_PUBLISHER_NAME: "CN=Matrix OS AB, O=Matrix OS AB, C=SE",
  MATRIX_DESKTOP_WINDOWS_SIGNING_ENDPOINT: "https://neu.codesigning.azure.net",
  MATRIX_DESKTOP_WINDOWS_SIGNING_ACCOUNT: "matrix-os",
  MATRIX_DESKTOP_WINDOWS_CERTIFICATE_PROFILE: "public-trust",
};

describe("resolveWindowsSigningConfig", () => {
  it("configures Azure Artifact Signing through the already-authenticated Azure CLI", () => {
    const config = resolveWindowsSigningConfig(azureEnvironment);

    expect(config).toEqual({
      forceCodeSigning: true,
      win: {
        azureSignOptions: {
          publisherName: "CN=Matrix OS AB, O=Matrix OS AB, C=SE",
          endpoint: "https://neu.codesigning.azure.net",
          codeSigningAccountName: "matrix-os",
          certificateProfileName: "public-trust",
          ExcludeEnvironmentCredential: "true",
          ExcludeWorkloadIdentityCredential: "true",
          ExcludeManagedIdentityCredential: "true",
          ExcludeSharedTokenCacheCredential: "true",
          ExcludeVisualStudioCredential: "true",
          ExcludeVisualStudioCodeCredential: "true",
          ExcludeAzureCliCredential: "false",
          ExcludeAzurePowerShellCredential: "true",
          ExcludeAzureDeveloperCliCredential: "true",
          ExcludeInteractiveBrowserCredential: "true",
        },
      },
    });
  });

  it("supports a conventional certificate as an explicit fallback", () => {
    const config = resolveWindowsSigningConfig({
      MATRIX_DESKTOP_WINDOWS_SIGNING_MODE: "certificate",
      MATRIX_DESKTOP_WINDOWS_PUBLISHER_NAME: "CN=Matrix OS AB, O=Matrix OS AB, C=SE",
      WIN_CSC_LINK: "base64:private-certificate-material",
      WIN_CSC_KEY_PASSWORD: "private-password",
    });

    expect(config).toEqual({
      forceCodeSigning: true,
      win: {
        signtoolOptions: {
          publisherName: "CN=Matrix OS AB, O=Matrix OS AB, C=SE",
          signingHashAlgorithms: ["sha256"],
        },
      },
    });
    expect(JSON.stringify(config)).not.toContain("private-certificate-material");
    expect(JSON.stringify(config)).not.toContain("private-password");
  });

  it.each([
    [{}, "MATRIX_DESKTOP_WINDOWS_SIGNING_MODE"],
    [
      {
        ...azureEnvironment,
        MATRIX_DESKTOP_WINDOWS_PUBLISHER_NAME: "Matrix OS AB",
      },
      "publisher",
    ],
    [
      {
        ...azureEnvironment,
        MATRIX_DESKTOP_WINDOWS_SIGNING_ENDPOINT: "https://example.com",
      },
      "endpoint",
    ],
    [
      {
        MATRIX_DESKTOP_WINDOWS_SIGNING_MODE: "certificate",
        MATRIX_DESKTOP_WINDOWS_PUBLISHER_NAME: "CN=Matrix OS AB",
        WIN_CSC_LINK: "base64:certificate",
      },
      "WIN_CSC_KEY_PASSWORD",
    ],
  ])("fails closed for incomplete or unsafe signing input", (environment, expectedMessage) => {
    expect(() => resolveWindowsSigningConfig(environment)).toThrow(expectedMessage);
  });
});
