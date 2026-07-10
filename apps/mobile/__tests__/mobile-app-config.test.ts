type MobileAppConfig = {
  expo?: {
    orientation?: string;
    ios?: {
      supportsTablet?: boolean;
    };
  };
};

const appConfig = require("../app.json") as MobileAppConfig;

describe("mobile native orientation configuration", () => {
  it("allows portrait and landscape on phones and tablets", () => {
    expect(appConfig.expo?.orientation).toBe("default");
    expect(appConfig.expo?.ios?.supportsTablet).toBe(true);
  });
});
