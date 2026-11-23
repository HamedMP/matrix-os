import type { ExpoConfig } from "expo/config";

import appJson from "../app.json";
import appConfig from "../app.config";

const ENV_KEYS = ["GOOGLE_SERVICES_JSON", "EAS_BUILD", "EAS_BUILD_PLATFORM"] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

function resolve(): ExpoConfig {
  return appConfig({ config: appJson.expo as Partial<ExpoConfig> } as Parameters<typeof appConfig>[0]);
}

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe("app config", () => {
  it("points Android at the google-services.json EAS provides as a file variable", () => {
    process.env.GOOGLE_SERVICES_JSON = "/home/expo/workingdir/google-services.json";

    expect(resolve().android?.googleServicesFile).toBe("/home/expo/workingdir/google-services.json");
  });

  it("keeps every app.json setting it does not add to", () => {
    process.env.GOOGLE_SERVICES_JSON = "/tmp/google-services.json";

    const { googleServicesFile, ...android } = resolve().android ?? {};
    expect(googleServicesFile).toBeDefined();
    expect({ ...resolve(), android }).toEqual(appJson.expo);
  });

  it("builds without Firebase on a computer that has no google-services.json", () => {
    expect(resolve().android?.googleServicesFile).toBeUndefined();
  });

  it("stops an EAS Android build that has no google-services.json, which could never get a push token", () => {
    process.env.EAS_BUILD = "true";
    process.env.EAS_BUILD_PLATFORM = "android";

    expect(resolve).toThrow(/GOOGLE_SERVICES_JSON/);
  });

  it("lets an EAS iOS build go ahead without google-services.json", () => {
    process.env.EAS_BUILD = "true";
    process.env.EAS_BUILD_PLATFORM = "ios";

    expect(resolve().android?.googleServicesFile).toBeUndefined();
  });
});
