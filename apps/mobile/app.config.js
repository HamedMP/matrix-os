const { nativeMobileTargetForOrigin, nativeMobileTargetPolicy } = require("@matrix-os/contracts/native-mobile-target");

// app.json remains the production source of truth. This setting is public and
// fixed at native build/JS export time; it never comes from a selected computer.
module.exports = ({ config }) => {
  const policy = nativeMobileTargetPolicy(nativeMobileTargetForOrigin(process.env.EXPO_PUBLIC_MATRIX_HOSTED_ORIGIN));
  if (policy.target === "production") return config;
  return {
    ...config,
    name: "Matrix OS Gmail Pilot",
    scheme: policy.scheme,
    ios: { ...config.ios, bundleIdentifier: policy.applicationId },
    android: { ...config.android, package: policy.applicationId },
    // The default exp+<slug> launcher scheme would otherwise be shared with
    // the primary dev client. Launch this build through its explicit scheme.
    plugins: [...(config.plugins ?? []), ["expo-dev-client", { addGeneratedScheme: false }]],
    updates: { ...config.updates, enabled: false },
    runtimeVersion: `gmail-pilot-${config.version}`,
  };
};
