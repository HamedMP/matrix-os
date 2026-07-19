import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseConfigFileTextToJson } from "typescript";

type MobileAppConfig = {
  expo?: {
    orientation?: string;
    android?: {
      package?: string;
    };
    ios?: {
      supportsTablet?: boolean;
    };
  };
};

type MobilePackageConfig = {
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
    production?: {
      autoIncrement?: boolean;
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
