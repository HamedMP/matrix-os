import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseConfigFileTextToJson } from "typescript";

type MobileAppConfig = {
  expo?: {
    orientation?: string;
    updates?: {
      url?: string;
      fallbackToCacheTimeout?: number;
    };
    runtimeVersion?: {
      policy?: string;
    };
    android?: {
      package?: string;
    };
    ios?: {
      supportsTablet?: boolean;
    };
    extra?: {
      eas?: {
        projectId?: string;
      };
    };
  };
};

type MobilePackageConfig = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

type MobileEasConfig = {
  cli?: {
    version?: string;
    appVersionSource?: string;
  };
  build?: {
    base?: {
      node?: string;
      pnpm?: string;
    };
    development?: { channel?: string };
    "development-device"?: { channel?: string };
    preview?: { channel?: string };
    production?: {
      autoIncrement?: boolean;
      channel?: string;
      android?: {
        buildType?: string;
      };
    };
  };
  submit?: {
    production?: {
      android?: {
        track?: string;
      };
    };
  };
};

const appConfig = require("../app.json") as MobileAppConfig;
const packageConfig = require("../package.json") as MobilePackageConfig;
const easConfigPath = join(__dirname, "../eas.json");
const parsedEasConfig = parseConfigFileTextToJson(
  easConfigPath,
  readFileSync(easConfigPath, "utf8"),
);

if (parsedEasConfig.error) {
  throw parsedEasConfig.error;
}

const easConfig = parsedEasConfig.config as MobileEasConfig;

describe("mobile native orientation configuration", () => {
  it("allows portrait and landscape on phones and tablets", () => {
    expect(appConfig.expo?.orientation).toBe("default");
    expect(appConfig.expo?.ios?.supportsTablet).toBe(true);
  });
});

describe("mobile Android release configuration", () => {
  it("declares the Expo config plugin dependency used by native plugins", () => {
    // Expo config plugins must stay aligned with SDK 57; upgrades should update
    // this pin deliberately instead of accepting an arbitrary transitive version.
    expect(packageConfig.devDependencies?.["@expo/config-plugins"]).toBe("57.0.2");
  });

  it("builds a versioned Android App Bundle with the supported toolchain", () => {
    expect(appConfig.expo?.android?.package).toBe("com.matrixos.mobile");
    expect(easConfig.cli?.version).toBe(">= 20.1.0");
    expect(easConfig.cli?.appVersionSource).toBe("remote");
    expect(easConfig.build?.base).toEqual({
      node: "24.14.0",
      pnpm: "10.33.4",
    });
    expect(easConfig.build?.production?.autoIncrement).toBe(true);
    expect(easConfig.build?.production?.android?.buildType).toBe("app-bundle");
  });

  it("defaults Android submissions to the internal Play track", () => {
    expect(easConfig.submit?.production?.android?.track).toBe("internal");
  });
});

describe("mobile over-the-air update configuration", () => {
  it("ships expo-updates so builds can fetch JS updates without a store release", () => {
    expect(packageConfig.dependencies?.["expo-updates"]).toBe("~57.0.8");
  });

  it("points updates at the EAS Update endpoint for this project", () => {
    const projectId = appConfig.expo?.extra?.eas?.projectId;
    expect(projectId).toBeTruthy();
    expect(appConfig.expo?.updates?.url).toBe(`https://u.expo.dev/${projectId}`);
  });

  it("gates updates on the app version so an update never lands on mismatched native code", () => {
    expect(appConfig.expo?.runtimeVersion?.policy).toBe("appVersion");
  });

  it("binds every build profile to its own update channel", () => {
    // A build with no channel can never receive an update, so each profile must
    // declare one and production must not share a channel with internal builds.
    expect(easConfig.build?.development?.channel).toBe("development");
    expect(easConfig.build?.["development-device"]?.channel).toBe("development");
    expect(easConfig.build?.preview?.channel).toBe("preview");
    expect(easConfig.build?.production?.channel).toBe("production");
  });
});
