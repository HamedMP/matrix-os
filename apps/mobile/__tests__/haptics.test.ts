import * as Haptics from "expo-haptics";

import { selectHaptic, successHaptic, tapHaptic, warningHaptic } from "../lib/haptics";

const haptics = jest.mocked(Haptics);

describe("haptics", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("plays a light tap for a press that starts something", () => {
    tapHaptic();
    expect(haptics.impactAsync).toHaveBeenCalledWith(Haptics.ImpactFeedbackStyle.Light);
  });

  it("plays the selection tick for moving between choices", () => {
    selectHaptic();
    expect(haptics.selectionAsync).toHaveBeenCalledTimes(1);
  });

  it("plays the success pattern when something finished as asked", () => {
    successHaptic();
    expect(haptics.notificationAsync).toHaveBeenCalledWith(Haptics.NotificationFeedbackType.Success);
  });

  it("plays the warning pattern when something did not work", () => {
    warningHaptic();
    expect(haptics.notificationAsync).toHaveBeenCalledWith(Haptics.NotificationFeedbackType.Warning);
  });

  it("logs a device without haptics instead of failing the action", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    haptics.selectionAsync.mockRejectedValueOnce(new TypeError("unavailable"));
    haptics.impactAsync.mockImplementationOnce(() => { throw new RangeError("no engine"); });

    expect(() => selectHaptic()).not.toThrow();
    expect(() => tapHaptic()).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();

    expect(warn).toHaveBeenCalledWith("[mobile] select haptic unavailable", "TypeError");
    expect(warn).toHaveBeenCalledWith("[mobile] tap haptic unavailable", "RangeError");
  });
});
