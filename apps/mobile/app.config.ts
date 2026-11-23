import type { ConfigContext, ExpoConfig } from "expo/config";

// app.json stays the source of truth. This file only adds what must not live in
// the public repo: Firebase's google-services.json, which Android needs for
// push tokens. EAS provides it as the file variable GOOGLE_SERVICES_JSON
// (spec 652, OQ-9).
export default ({ config }: ConfigContext): ExpoConfig => {
  const googleServicesFile = process.env.GOOGLE_SERVICES_JSON;

  if (!googleServicesFile && process.env.EAS_BUILD === "true" && process.env.EAS_BUILD_PLATFORM === "android") {
    throw new Error(
      "GOOGLE_SERVICES_JSON is not set for this EAS environment. Android builds without it can never get a push token. " +
        "Add google-services.json as an EAS file variable named GOOGLE_SERVICES_JSON.",
    );
  }

  return {
    ...config,
    android: {
      ...config.android,
      ...(googleServicesFile ? { googleServicesFile } : {}),
    },
  } as ExpoConfig;
};
