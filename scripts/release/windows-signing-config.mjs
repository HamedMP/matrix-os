const AZURE_SIGNING_HOST = /(^|\.)codesigning\.azure\.net$/i;
const SAFE_RESOURCE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function required(environment, name) {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required for Windows release signing`);
  return value;
}

function publisherName(environment) {
  const value = required(environment, "MATRIX_DESKTOP_WINDOWS_PUBLISHER_NAME");
  if (!value.startsWith("CN=") || value.length > 512 || /[\r\n]/.test(value)) {
    throw new Error("Windows signing publisher must be the full certificate subject beginning with CN=");
  }
  return value;
}

function safeResourceName(environment, name) {
  const value = required(environment, name);
  if (!SAFE_RESOURCE_NAME.test(value)) {
    throw new Error(`${name} contains unsupported characters`);
  }
  return value;
}

function azureEndpoint(environment) {
  const raw = required(environment, "MATRIX_DESKTOP_WINDOWS_SIGNING_ENDPOINT");
  let endpoint;
  try {
    endpoint = new URL(raw);
  } catch {
    throw new Error("Windows signing endpoint must be a valid Azure Artifact Signing URL");
  }
  if (
    endpoint.protocol !== "https:" ||
    !AZURE_SIGNING_HOST.test(endpoint.hostname) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.port ||
    (endpoint.pathname !== "/" && endpoint.pathname !== "") ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw new Error("Windows signing endpoint must be an HTTPS *.codesigning.azure.net origin");
  }
  return endpoint.origin;
}

export function resolveWindowsSigningConfig(environment = process.env) {
  const mode = required(environment, "MATRIX_DESKTOP_WINDOWS_SIGNING_MODE");
  const publisher = publisherName(environment);

  if (mode === "azure") {
    return {
      forceCodeSigning: true,
      win: {
        azureSignOptions: {
          publisherName: publisher,
          endpoint: azureEndpoint(environment),
          codeSigningAccountName: safeResourceName(
            environment,
            "MATRIX_DESKTOP_WINDOWS_SIGNING_ACCOUNT",
          ),
          certificateProfileName: safeResourceName(
            environment,
            "MATRIX_DESKTOP_WINDOWS_CERTIFICATE_PROFILE",
          ),
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
    };
  }

  if (mode === "certificate") {
    required(environment, "WIN_CSC_LINK");
    required(environment, "WIN_CSC_KEY_PASSWORD");
    return {
      forceCodeSigning: true,
      win: {
        signtoolOptions: {
          publisherName: publisher,
          signingHashAlgorithms: ["sha256"],
        },
      },
    };
  }

  throw new Error(
    "MATRIX_DESKTOP_WINDOWS_SIGNING_MODE must be either azure or certificate",
  );
}
