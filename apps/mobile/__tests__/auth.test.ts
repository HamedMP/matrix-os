import * as LocalAuthentication from "expo-local-authentication";

jest.mock("expo-local-authentication", () => ({
  hasHardwareAsync: jest.fn(() => Promise.resolve(true)),
  isEnrolledAsync: jest.fn(() => Promise.resolve(true)),
  authenticateAsync: jest.fn(() => Promise.resolve({ success: true })),
  supportedAuthenticationTypesAsync: jest.fn(() => Promise.resolve([2])),
  AuthenticationType: { FINGERPRINT: 1, FACIAL_RECOGNITION: 2, IRIS: 3 },
}));

jest.mock("expo-secure-store", () => {
  const store: Record<string, string> = {};
  return {
    getItemAsync: jest.fn((key: string) => Promise.resolve(store[key] ?? null)),
    setItemAsync: jest.fn((key: string, value: string) => {
      store[key] = value;
      return Promise.resolve();
    }),
    deleteItemAsync: jest.fn((key: string) => {
      delete store[key];
      return Promise.resolve();
    }),
  };
});

import {
  isBiometricAvailable,
  authenticateBiometric,
  getSupportedBiometricTypes,
  getBiometricLabel,
} from "../lib/auth";

describe("auth", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("isBiometricAvailable", () => {
    it("returns true when hardware and enrollment available", async () => {
      expect(await isBiometricAvailable()).toBe(true);
    });

    it("returns false when no hardware", async () => {
      (LocalAuthentication.hasHardwareAsync as jest.Mock).mockResolvedValueOnce(false);
      expect(await isBiometricAvailable()).toBe(false);
    });

    it("returns false when not enrolled", async () => {
      (LocalAuthentication.isEnrolledAsync as jest.Mock).mockResolvedValueOnce(false);
      expect(await isBiometricAvailable()).toBe(false);
    });
  });

  describe("authenticateBiometric", () => {
    it("returns true when biometric is disabled in settings", async () => {
      // Default settings have biometricEnabled: false
      expect(await authenticateBiometric()).toBe(true);
    });

    it("returns true when no hardware available even if enabled", async () => {
      const SecureStore = require("expo-secure-store");
      SecureStore.getItemAsync.mockResolvedValueOnce(
        JSON.stringify({ biometricEnabled: true }),
      );
      (LocalAuthentication.hasHardwareAsync as jest.Mock).mockResolvedValueOnce(false);
      expect(await authenticateBiometric()).toBe(true);
    });
  });

  describe("getSupportedBiometricTypes", () => {
    it("returns supported types", async () => {
      const types = await getSupportedBiometricTypes();
      expect(types).toEqual([2]);
    });
  });

  describe("getBiometricLabel", () => {
    it("returns Face ID for facial recognition", () => {
      expect(getBiometricLabel([LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION])).toBe("Face ID");
    });

    it("returns Touch ID for fingerprint", () => {
      expect(getBiometricLabel([LocalAuthentication.AuthenticationType.FINGERPRINT])).toBe("Touch ID");
    });

    it("returns Iris for iris", () => {
      expect(getBiometricLabel([LocalAuthentication.AuthenticationType.IRIS])).toBe("Iris");
    });

    it("returns Biometric as fallback", () => {
      expect(getBiometricLabel([])).toBe("Biometric");
    });

    it("prefers Face ID over fingerprint", () => {
      expect(
        getBiometricLabel([
          LocalAuthentication.AuthenticationType.FINGERPRINT,
          LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION,
        ]),
      ).toBe("Face ID");
    });
  });
});
